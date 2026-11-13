import { Schema, model, type HydratedDocument, type InferSchemaType } from 'mongoose';
import { ROLES, TEAMS, type UserDTO } from '@epicenter/shared';

const userSchema = new Schema(
  {
    email: { type: String, required: true, lowercase: true, trim: true },
    passwordHash: { type: String, required: true },
    name: { type: String, required: true },
    role: { type: String, enum: ROLES, required: true },
    teams: { type: [{ type: String, enum: TEAMS }], default: [] },
  },
  { collection: 'users', timestamps: true, versionKey: false },
);
userSchema.index({ email: 1 }, { unique: true });

export type User = InferSchemaType<typeof userSchema>;
export type UserDoc = HydratedDocument<User>;
export const UserModel = model('User', userSchema);

export const toUserDTO = (u: Pick<User, 'email' | 'name' | 'role' | 'teams'> & { _id: { toString(): string } }): UserDTO => ({
  id: u._id.toString(),
  email: u.email,
  name: u.name,
  role: u.role,
  teams: [...u.teams] as UserDTO['teams'],
});
