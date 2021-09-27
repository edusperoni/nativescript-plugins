import type { Sms } from './sms';

export interface FilterOptions {
	max?: number;
	sort?: string;
	order?: string;
}

export type Inbox = { data: Sms[]; total: number; status: string };
