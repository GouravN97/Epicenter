import { create } from 'zustand';

export interface Toast {
  id: number;
  tone: 'crit' | 'ok' | 'info';
  title: string;
  body?: string;
  /** In-app link for the action button. */
  to?: string;
  action?: string;
}

interface ToastState {
  toasts: Toast[];
  push(t: Omit<Toast, 'id'>): void;
  dismiss(id: number): void;
}

let next = 1;
const MAX_VISIBLE = 3;

export const useToasts = create<ToastState>((set) => ({
  toasts: [],
  push: (t) => set((s) => ({ toasts: [...s.toasts, { ...t, id: next++ }].slice(-MAX_VISIBLE) })),
  dismiss: (id) => set((s) => ({ toasts: s.toasts.filter((t) => t.id !== id) })),
}));
