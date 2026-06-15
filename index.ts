export interface User {
  id: string;
  phone: string;
  plan: 'free' | 'basic' | 'pro' | 'premium';
  planExpiry: string | null;
  promptsUsedToday: number;
  promptsLimit: number;
}

export interface AuthContextType {
  user: User | null;
  loading: boolean;
  login: (phone: string, otp: string, termsAccepted: boolean) => Promise<void>;
  sendOTP: (phone: string) => Promise<{ success: boolean; message: string; expiresIn?: number }>;
  logout: () => void;
  checkSession: (token: string) => Promise<void>;
  refreshUser: () => Promise<void>;
}

export type ChatMode = 'standard' | 'architect' | 'analyst' | 'matrix' | 'optimize';

export interface ChatMessage {
  id: string;
  sessionId: string;
  role: 'user' | 'assistant';
  content: string;
  attachments?: Attachment[];
  mindmapData?: { mermaid: string } | null;
  createdAt: string;
}

export interface Attachment {
  type: string;
  data: string;
  name: string;
}

export interface PlanConfig {
  id: string;
  name: string;
  price: number;
  duration: string;
  promptsLimit: number;
  features: string[];
  popular?: boolean;
}

export const PLAN_CONFIGS: PlanConfig[] = [
  { id: 'free', name: 'Free Trial', price: 0, duration: 'Daily', promptsLimit: 30, features: ['30 prompts per day', 'Standard AI mode', 'Basic responses', 'Limited features'] },
  { id: 'basic', name: 'Basic', price: 99, duration: '1 Month', promptsLimit: 100, popular: true, features: ['100 prompts per day', 'All AI modes', 'Priority support', 'File uploads', 'Mind map generation'] },
  { id: 'pro', name: 'Pro', price: 199, duration: '3 Months', promptsLimit: 500, features: ['500 prompts per day', 'All AI modes', 'Priority support', 'Unlimited file uploads', 'Mind map generation', 'Advanced optimizations'] },
  { id: 'premium', name: 'Premium', price: 999, duration: '1 Year', promptsLimit: 999999, features: ['Unlimited prompts', 'All AI modes', '24/7 Priority support', 'Unlimited everything', 'Early access features', 'Custom integrations'] }
];
