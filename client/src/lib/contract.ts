// TEMPORARY local mirror of the pieces of `@epicenter/shared` that the B1 scaffold needs.
// The shared package (task A1) is not on `main` yet. Once it is merged, delete this file and
// change imports of './contract' / '../lib/contract' to '@epicenter/shared' — names and shapes match.

export type Role = 'admin' | 'sre' | 'viewer';
export type Team = 'platform' | 'commerce' | 'payments' | 'data';

export interface UserDTO {
  id: string;
  email: string;
  name: string;
  role: Role;
  teams: Team[];
}

export interface LoginBody {
  email: string;
  password: string;
}

export interface LoginResponse {
  token: string;
  user: UserDTO;
}

export interface ApiError {
  error: { code: string; message: string; issues?: unknown[] };
}

export const NS_DASH = '/dash';
