import type { SuperOpsTicket } from '../../types';

export interface PSAClient {
  pollNewTickets(since: number): Promise<SuperOpsTicket[]>;
  addTicketNote(ticketId: string, note: string, isPrivate: boolean): Promise<void>;
  testConnection(): Promise<boolean>;
}
