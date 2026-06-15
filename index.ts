import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2.57.4';

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, POST, PUT, DELETE, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, Authorization, X-Client-Info, Apikey",
};

const PLAN_CONFIGS: Record<string, { days: number; promptsLimit: number }> = {
  basic: { days: 30, promptsLimit: 100 },
  pro: { days: 90, promptsLimit: 500 },
  premium: { days: 365, promptsLimit: 999999 }
};

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") return new Response(null, { status: 200, headers: corsHeaders });
  if (req.method !== "POST") return new Response(JSON.stringify({ error: "Method not allowed" }), { status: 405, headers: { ...corsHeaders, "Content-Type": "application/json" } });

  try {
    const supabaseUrl = Deno.env.get('SUPABASE_URL')!;
    const supabaseServiceKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;
    const razorpaySecret = Deno.env.get('RAZORPAY_SECRET');
    const supabase = createClient(supabaseUrl, supabaseServiceKey);
    const body = await req.json();
    const { razorpay_order_id, razorpay_payment_id, razorpay_signature } = body;

    if (!razorpay_order_id || !razorpay_payment_id || !razorpay_signature) return new Response(JSON.stringify({ error: "Missing payment details" }), { status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" } });

    const encoder = new TextEncoder();
    const data = encoder.encode(`${razorpay_order_id}|${razorpay_payment_id}`);
    const keyData = encoder.encode(razorpaySecret);
    const key = await crypto.subtle.importKey('raw', keyData, { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
    const signature = await crypto.subtle.sign('HMAC', key, data);
    const generatedSignature = btoa(String.fromCharCode(...new Uint8Array(signature)));

    if (generatedSignature !== razorpay_signature) return new Response(JSON.stringify({ error: "Payment verification failed" }), { status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" } });

    const { data: transaction, error: txnError } = await supabase.from('transactions').select('*, users(*)').eq('razorpay_order_id', razorpay_order_id).single();
    if (txnError || !transaction) return new Response(JSON.stringify({ error: "Transaction not found" }), { status: 404, headers: { ...corsHeaders, "Content-Type": "application/json" } });
    if (transaction.status !== 'pending') return new Response(JSON.stringify({ error: "Already processed" }), { status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" } });

    const planConfig = PLAN_CONFIGS[transaction.plan];
    if (!planConfig) return new Response(JSON.stringify({ error: "Invalid plan" }), { status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" } });

    const expiryDate = new Date(Date.now() + planConfig.days * 24 * 60 * 60 * 1000);
    await supabase.from('transactions').update({ razorpay_payment_id, razorpay_signature, status: 'completed', updated_at: new Date().toISOString() }).eq('id', transaction.id);
    const { data: updatedUser } = await supabase.from('users').update({ plan: transaction.plan, plan_expiry: expiryDate.toISOString(), prompts_limit: planConfig.promptsLimit, updated_at: new Date().toISOString() }).eq('id', transaction.user_id).select().single();

    return new Response(JSON.stringify({ success: true, message: "Payment successful! Plan activated.", plan: transaction.plan, planExpiry: expiryDate.toISOString(), promptsLimit: planConfig.promptsLimit, user: { id: updatedUser.id, phone: updatedUser.phone, plan: updatedUser.plan, planExpiry: updatedUser.plan_expiry, promptsLimit: updatedUser.prompts_limit } }), { status: 200, headers: { ...corsHeaders, "Content-Type": "application/json" } });
  } catch (error) {
    console.error('Verify payment error:', error);
    return new Response(JSON.stringify({ error: "Internal server error" }), { status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" } });
  }
});
