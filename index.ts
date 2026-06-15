import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2.57.4';

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, POST, PUT, DELETE, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, Authorization, X-Client-Info, Apikey",
};

const PLAN_CONFIGS: Record<string, { amount: number; days: number; promptsLimit: number; name: string }> = {
  basic: { amount: 9900, days: 30, promptsLimit: 100, name: 'Basic Plan' },
  pro: { amount: 19900, days: 90, promptsLimit: 500, name: 'Pro Plan' },
  premium: { amount: 99900, days: 365, promptsLimit: 999999, name: 'Premium Plan' }
};

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") return new Response(null, { status: 200, headers: corsHeaders });
  if (req.method !== "POST") return new Response(JSON.stringify({ error: "Method not allowed" }), { status: 405, headers: { ...corsHeaders, "Content-Type": "application/json" } });

  try {
    const supabaseUrl = Deno.env.get('SUPABASE_URL')!;
    const supabaseServiceKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;
    const razorpayKeyId = Deno.env.get('RAZORPAY_KEY');
    const razorpaySecret = Deno.env.get('RAZORPAY_SECRET');
    const supabase = createClient(supabaseUrl, supabaseServiceKey);
    const body = await req.json();
    const { sessionToken, plan } = body;

    if (!sessionToken) return new Response(JSON.stringify({ error: "Session required" }), { status: 401, headers: { ...corsHeaders, "Content-Type": "application/json" } });
    if (!plan || !PLAN_CONFIGS[plan]) return new Response(JSON.stringify({ error: "Invalid plan" }), { status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" } });

    const { data: session, error } = await supabase.from('user_sessions').select(`*, users!inner(*)`).eq('session_token', sessionToken).gt('expires_at', new Date().toISOString()).single();
    if (error || !session) return new Response(JSON.stringify({ error: "Invalid session" }), { status: 401, headers: { ...corsHeaders, "Content-Type": "application/json" } });

    const user = session.users;
    const planConfig = PLAN_CONFIGS[plan];
    const auth = btoa(`${razorpayKeyId}:${razorpaySecret}`);
    const orderResponse = await fetch('https://api.razorpay.com/v1/orders', { method: 'POST', headers: { 'Authorization': `Basic ${auth}`, 'Content-Type': 'application/json' }, body: JSON.stringify({ amount: planConfig.amount, currency: 'INR', receipt: `rcpt_${user.id}_${Date.now()}`, payment_capture: 1 }) });

    if (!orderResponse.ok) return new Response(JSON.stringify({ error: "Failed to create order" }), { status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" } });
    const orderData = await orderResponse.json();
    await supabase.from('transactions').insert({ user_id: user.id, razorpay_order_id: orderData.id, amount: planConfig.amount, currency: 'INR', plan, status: 'pending' });

    return new Response(JSON.stringify({ success: true, orderId: orderData.id, amount: planConfig.amount, currency: 'INR', plan, planName: planConfig.name, razorpayKey: razorpayKeyId, prefill: { contact: user.phone } }), { status: 200, headers: { ...corsHeaders, "Content-Type": "application/json" } });
  } catch (error) {
    console.error('Payment error:', error);
    return new Response(JSON.stringify({ error: "Internal server error" }), { status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" } });
  }
});
