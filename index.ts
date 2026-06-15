import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2.57.4';

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, POST, PUT, DELETE, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, Authorization, X-Client-Info, Apikey",
};

function generateToken(): string {
  const array = new Uint8Array(32);
  crypto.getRandomValues(array);
  return Array.from(array, (byte) => byte.toString(16).padStart(2, '0')).join('');
}

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") return new Response(null, { status: 200, headers: corsHeaders });
  if (req.method !== "POST") return new Response(JSON.stringify({ error: "Method not allowed" }), { status: 405, headers: { ...corsHeaders, "Content-Type": "application/json" } });

  try {
    const supabaseUrl = Deno.env.get('SUPABASE_URL')!;
    const supabaseServiceKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;
    const supabase = createClient(supabaseUrl, supabaseServiceKey);
    const body = await req.json();
    const { phone, otp, termsAccepted } = body;

    if (!phone || !otp) return new Response(JSON.stringify({ error: "Phone and OTP are required" }), { status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" } });
    if (!termsAccepted) return new Response(JSON.stringify({ error: "You must accept the Terms of Service" }), { status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" } });

    const { data: otpRecord, error: otpError } = await supabase.from('otp_attempts').select('*').eq('phone', phone).eq('verified', false).order('created_at', { ascending: false }).limit(1).single();
    if (otpError || !otpRecord) return new Response(JSON.stringify({ error: "Invalid or expired OTP" }), { status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" } });
    if (new Date(otpRecord.expires_at) < new Date()) return new Response(JSON.stringify({ error: "OTP has expired" }), { status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" } });

    const failedAttempts = otpRecord.attempts || 0;
    if (failedAttempts >= 3) {
      const blockUntil = new Date(Date.now() + 15 * 60 * 1000);
      await supabase.from('users').upsert({ phone, is_blocked: true, blocked_until: blockUntil.toISOString() });
      return new Response(JSON.stringify({ error: "Too many failed attempts. Account blocked.", blocked: true }), { status: 429, headers: { ...corsHeaders, "Content-Type": "application/json" } });
    }

    if (otpRecord.otp !== otp) {
      await supabase.from('otp_attempts').update({ attempts: failedAttempts + 1 }).eq('id', otpRecord.id);
      return new Response(JSON.stringify({ error: `Invalid OTP. ${3 - (failedAttempts + 1)} attempts remaining` }), { status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" } });
    }

    await supabase.from('otp_attempts').update({ verified: true }).eq('id', otpRecord.id);

    const { data: existingUser } = await supabase.from('users').select('*').eq('phone', phone).single();
    let user;
    if (existingUser) {
      const { data } = await supabase.from('users').update({ terms_accepted: true, is_blocked: false, blocked_until: null }).eq('phone', phone).select().single();
      user = data;
    } else {
      const { data } = await supabase.from('users').insert({ phone, plan: 'free', prompts_limit: 30, terms_accepted: true }).select().single();
      user = data;
    }

    const sessionToken = generateToken();
    const expiresAt = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000);
    await supabase.from('user_sessions').insert({ user_id: user.id, session_token: sessionToken, expires_at: expiresAt.toISOString() });

    return new Response(JSON.stringify({ success: true, message: "Login successful", user: { id: user.id, phone: user.phone, plan: user.plan, planExpiry: user.plan_expiry, promptsUsedToday: user.prompts_used_today, promptsLimit: user.prompts_limit }, sessionToken, expiresAt: expiresAt.toISOString() }), { status: 200, headers: { ...corsHeaders, "Content-Type": "application/json" } });
  } catch (error) {
    console.error('Error in verify-otp:', error);
    return new Response(JSON.stringify({ error: "Internal server error" }), { status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" } });
  }
});
