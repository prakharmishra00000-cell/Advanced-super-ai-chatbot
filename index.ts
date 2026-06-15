import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2.57.4';

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, POST, PUT, DELETE, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, Authorization, X-Client-Info, Apikey",
};

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") return new Response(null, { status: 200, headers: corsHeaders });
  if (req.method !== "POST") return new Response(JSON.stringify({ error: "Method not allowed" }), { status: 405, headers: { ...corsHeaders, "Content-Type": "application/json" } });

  try {
    const supabaseUrl = Deno.env.get('SUPABASE_URL')!;
    const supabaseServiceKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;
    const fast2smsKey = Deno.env.get('FAST2SMS_KEY');
    const supabase = createClient(supabaseUrl, supabaseServiceKey);
    const body = await req.json();
    const { phone } = body;

    if (!phone || !/^[6-9]\d{9}$/.test(phone)) {
      return new Response(JSON.stringify({ error: "Invalid phone number" }), { status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" } });
    }

    const { data: existingUser } = await supabase.from('users').select('is_blocked, blocked_until').eq('phone', phone).single();
    if (existingUser?.is_blocked && existingUser.blocked_until) {
      const blockedUntil = new Date(existingUser.blocked_until);
      if (blockedUntil > new Date()) {
        const remainingMinutes = Math.ceil((blockedUntil.getTime() - Date.now()) / 60000);
        return new Response(JSON.stringify({ error: `Account blocked. Try again in ${remainingMinutes} minutes.`, blocked: true }), { status: 429, headers: { ...corsHeaders, "Content-Type": "application/json" } });
      } else {
        await supabase.from('users').update({ is_blocked: false, blocked_until: null }).eq('phone', phone);
      }
    }

    const fifteenMinutesAgo = new Date(Date.now() - 15 * 60 * 1000);
    const { data: recentAttempts } = await supabase.from('otp_attempts').select('*').eq('phone', phone).gte('created_at', fifteenMinutesAgo.toISOString()).order('created_at', { ascending: false });
    if (recentAttempts && recentAttempts.length >= 3) {
      const blockUntil = new Date(Date.now() + 15 * 60 * 1000);
      await supabase.from('users').upsert({ phone, is_blocked: true, blocked_until: blockUntil.toISOString() });
      return new Response(JSON.stringify({ error: "Too many OTP requests. Account blocked for 15 minutes.", blocked: true }), { status: 429, headers: { ...corsHeaders, "Content-Type": "application/json" } });
    }

    const otp = Math.floor(100000 + Math.random() * 900000).toString();
    const expiresAt = new Date(Date.now() + 2 * 60 * 1000);
    await supabase.from('otp_attempts').insert({ phone, otp, expires_at: expiresAt.toISOString() });

    if (fast2smsKey) {
      try {
        const formData = new FormData();
        formData.append('route', 'q');
        formData.append('message', `Your AI Bot verification code is ${otp}. Valid for 2 minutes.`);
        formData.append('language', 'english');
        formData.append('flash', '0');
        formData.append('numbers', phone);
        await fetch('https://www.fast2sms.com/dev/bulkV2', { method: 'POST', headers: { 'authorization': fast2smsKey }, body: formData });
      } catch (smsError) { console.error('Fast2SMS error:', smsError); }
    }

    return new Response(JSON.stringify({ success: true, message: "OTP sent successfully", expiresIn: 120 }), { status: 200, headers: { ...corsHeaders, "Content-Type": "application/json" } });
  } catch (error) {
    console.error('Error in send-otp:', error);
    return new Response(JSON.stringify({ error: "Internal server error" }), { status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" } });
  }
});
