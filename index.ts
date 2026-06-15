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
    const supabase = createClient(supabaseUrl, supabaseServiceKey);
    const body = await req.json();
    const { sessionToken } = body;

    if (!sessionToken) return new Response(JSON.stringify({ error: "Token required" }), { status: 401, headers: { ...corsHeaders, "Content-Type": "application/json" } });

    const { data: session, error } = await supabase.from('user_sessions').select(`*, users!inner(*)`).eq('session_token', sessionToken).gt('expires_at', new Date().toISOString()).single();
    if (error || !session) return new Response(JSON.stringify({ valid: false, error: "Invalid or expired session" }), { status: 200, headers: { ...corsHeaders, "Content-Type": "application/json" } });

    const user = session.users;

    if (user.plan !== 'free' && user.plan_expiry && new Date(user.plan_expiry) < new Date()) {
      const { data: updatedUser } = await supabase.from('users').update({ plan: 'free', plan_expiry: null, prompts_limit: 30 }).eq('id', user.id).select().single();
      return new Response(JSON.stringify({ valid: true, user: { id: updatedUser.id, phone: updatedUser.phone, plan: 'free', planExpiry: null, promptsUsedToday: updatedUser.prompts_used_today, promptsLimit: 30 }, planExpired: true, message: "Subscription expired" }), { status: 200, headers: { ...corsHeaders, "Content-Type": "application/json" } });
    }

    const today = new Date().toISOString().split('T')[0];
    if (user.last_reset_date !== today) {
      const { data: updatedUser } = await supabase.from('users').update({ prompts_used_today: 0, last_reset_date: today }).eq('id', user.id).select().single();
      return new Response(JSON.stringify({ valid: true, user: { id: updatedUser.id, phone: updatedUser.phone, plan: updatedUser.plan, planExpiry: updatedUser.plan_expiry, promptsUsedToday: 0, promptsLimit: updatedUser.prompts_limit } }), { status: 200, headers: { ...corsHeaders, "Content-Type": "application/json" } });
    }

    return new Response(JSON.stringify({ valid: true, user: { id: user.id, phone: user.phone, plan: user.plan, planExpiry: user.plan_expiry, promptsUsedToday: user.prompts_used_today, promptsLimit: user.prompts_limit } }), { status: 200, headers: { ...corsHeaders, "Content-Type": "application/json" } });
  } catch (error) {
    console.error('Check session error:', error);
    return new Response(JSON.stringify({ error: "Internal server error" }), { status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" } });
  }
});
