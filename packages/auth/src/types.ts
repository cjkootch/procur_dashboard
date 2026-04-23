import type { Company, User } from '@procur/db';

export type CurrentUser = User;
export type CurrentCompany = Company;

export type AuthContext = {
  user: CurrentUser;
  company: CurrentCompany | null;
};
