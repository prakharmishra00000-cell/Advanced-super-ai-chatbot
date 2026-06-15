import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2.57.4';

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, POST, PUT, DELETE, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, Authorization, X-Client-Info, Apikey",
};

const SYSTEM_PROMPTS: Record<string, string> = {
  standard: `You are an expert AI assistant. Respond in the language the user uses (Hindi, Hinglish, or English). Be concise but thorough.`,
  architect: `You are a senior software architect. Provide architecture diagrams in Mermaid.js format when helpful.`,
  analyst: `You are a data analyst expert. Present findings clearly with actionable recommendations.`,
  matrix: `You are a Matrix Simulation AI. Present information in structured matrix/tabular format.`,
  optimize: `You are an optimization expert. Provide specific optimizations with before/after comparisons.`
};

async function getAvailableApiKey(supabase: any): Promise<{ key: string; index: number } | null> {
  const today = new Date().toISOString().split('T')[0];
  await supabase.from('api_key_usage').update({ requests_today: 0, is_rate_limited: false, rate_limited_until: null, last_reset_date: today }).lt('last_reset_date', today);
  const now = new Date().toISOString();
  const { data: keys } = await supabase.from('api_key_usage').select('*').or(`is_rate_limited.eq.false,rate_limited_until.lt.${now}`).order('requests_today', { ascending: true }).limit(1);
  if (!keys || keys.length === 0) return null;
  const keyRecord = keys[0];
  const apiKey = Deno.env.get(`GEMINI_KEY_${keyRecord.key_index}`);
  if (!apiKey) return null;
  await supabase.from('api_key_usage').update({ requests_today: keyRecord.requests_today + 1 }).eq('key_index', keyRecord.key_index);
  return { key: apiKey, index: keyRecord.key_index };
}

async function markKeyRateLimited(supabase: any, keyIndex: number) {
  const rateLimitedUntil = new Date(Date.now() + 60 * 60 * 1000);
  await supabase.from('api_key_usage').update({ is_rate_limited: true, rate_limited_until: rateLimitedUntil.toISOString() }).eq('key_index', keyIndex);
}

async function callGeminiWithRetry(supabase: any, contents: Array<{ role: string; parts: Array<{ text: string }> }>, systemPrompt: string, maxRetries: number = 9): Promise<string> {
  let lastError: Error | null = null;
  for (let attempt = 0; attempt < maxRetries; attempt++) {
    const keyInfo = await getAvailableApiKey(supabase);
    if (!keyInfo) throw new Error('All 9 API keys are rate limited');
    try {
      const response = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/gemini-2.0-flash:generateContent?key=${keyInfo.key}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ systemInstruction: { parts: [{ text: systemPrompt }] }, contents, generationConfig: { temperature: 0.9, topK: 40, topP: 0.95, maxOutputTokens: 8192 }, safetySettings: [{ category: "HARM_CATEGORY_HARASSMENT", threshold: "BLOCK_MEDIUM_AND_ABOVE" }, { category: "HARM_CATEGORY_HATE_SPEECH", threshold: "BLOCK_MEDIUM_AND_ABOVE" }, { category: "HARM_CATEGORY_SEXUALLY_EXPLICIT", threshold: "BLOCK_MEDIUM_AND_ABOVE" }, { category: "HARM_CATEGORY_DANGEROUS_CONTENT", threshold: "BLOCK_MEDIUM_AND_ABOVE" }] })
      });
      if (!response.ok) {
        if (response.status === 429) { await markKeyRateLimited(supabase, keyInfo.index); continue; }
        throw new Error(`Gemini API error: ${response.status}`);
      }
      const data = await response.json();
      if (data.candidates?.[0]?.content?.parts?.[0]?.text) return data.candidates[0].content.parts[0].text;
      throw new Error('No response from Gemini');
    } catch (error) { lastError = error as Error; await new Promise(r => setTimeout(r, 500)); }
  }
  throw lastError || new Error('Failed after trying all keys');
}

function extractMermaidCode(text: string): string | null { const match = text.match(/```mermaid\n([\s\S]*?)\n```/); return match ? match[1] : null; }

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") return new Response(null, { status: 200, headers: corsHeaders });
  if (req.method !== "POST") return new Response(JSON.stringify({ error: "Method not allowed" }), { status: 405, headers: { ...corsHeaders, "Content-Type": "application/json" } });

  try {
    const supabaseUrl = Deno.env.get('SUPABASE_URL')!;
    const supabaseServiceKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;
    const supabase = createClient(supabaseUrl, supabaseServiceKey);
    const body = await req.json();
    const { sessionToken, message, mode, sessionId, attachments } = body;

    if (!sessionToken || !message) return new Response(JSON.stringify({ error: "Session token and message required" }), { status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" } });

    const { data: session, error: sessionError } = await supabase.from('user_sessions').select(`*, users!inner(*)`).eq('session_token', sessionToken).gt('expires_at', new Date().toISOString()).single();
    if (sessionError || !session) return new Response(JSON.stringify({ error: "Invalid or expired session" }), { status: 401, headers: { ...corsHeaders, "Content-Type": "application/json" } });

    const user = session.users;
    if (user.plan !== 'free' && user.plan_expiry && new Date(user.plan_expiry) < new Date()) { await supabase.from('users').update({ plan: 'free', plan_expiry: null, prompts_limit: 30 }).eq('id', user.id); user.plan = 'free'; user.prompts_limit = 30; }

    const today = new Date().toISOString().split('T')[0];
    if (user.last_reset_date !== today) { await supabase.from('users').update({ prompts_used_today: 0, last_reset_date: today }).eq('id', user.id); user.prompts_used_today = 0; }

    if (user.prompts_used_today >= user.prompts_limit) return new Response(JSON.stringify({ error: "Daily limit reached", limitExceeded: true }), { status: 429, headers: { ...corsHeaders, "Content-Type": "application/json" } });

    let chatSessionId = sessionId;
    if (!chatSessionId) { const { data: newSession } = await supabase.from('chat_sessions').insert({ user_id: user.id, mode: mode || 'standard', title: message.slice(0, 50) }).select().single(); chatSessionId = newSession.id; }

    const { data: previousMessages } = await supabase.from('chat_messages').select('*').eq('session_id', chatSessionId).order('created_at', { ascending: true }).limit(10);
    const contents: Array<{ role: string; parts: Array<{ text: string }> }> = [];
    if (previousMessages) for (const msg of previousMessages) contents.push({ role: msg.role === 'user' ? 'user' : 'model', parts: [{ text: msg.content }] });

    let fullMessage = message;
    if (attachments?.length > 0) for (const att of attachments) fullMessage += `\n\n[${att.type.startsWith('image/') ? 'Image' : 'File'}: ${att.name}]`;
    contents.push({ role: 'user', parts: [{ text: fullMessage }] });

    const systemPrompt = SYSTEM_PROMPTS[mode] || SYSTEM_PROMPTS.standard;
    const response = await callGeminiWithRetry(supabase, contents, systemPrompt);
    const mindmapData = extractMermaidCode(response);

    await supabase.from('chat_messages').insert({ session_id: chatSessionId, role: 'user', content: message, attachments: attachments || null });
    const { data: assistantMessage } = await supabase.from('chat_messages').insert({ session_id: chatSessionId, role: 'assistant', content: response, mindmap_data: mindmapData ? { mermaid: mindmapData } : null }).select().single();
    const newCount = user.prompts_used_today + 1;
    await supabase.from('users').update({ prompts_used_today: newCount }).eq('id', user.id);

    return new Response(JSON.stringify({ success: true, sessionId: chatSessionId, messageId: assistantMessage.id, response, mindmapData, promptsUsedToday: newCount, promptsLimit: user.prompts_limit, plan: user.plan }), { status: 200, headers: { ...corsHeaders, "Content-Type": "application/json" } });
  } catch (error) {
    console.error('Error in chat:', error);
    return new Response(JSON.stringify({ error: error.message || "Internal server error" }), { status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" } });
  }
});
