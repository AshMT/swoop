import type { SuperOpsTicket, TicketConversation } from '../../types';

export interface PSAClient {
  pollNewTickets(since: number): Promise<SuperOpsTicket[]>;
  addTicketNote(ticketId: string, note: string, isPrivate: boolean): Promise<void>;
  addTicketReply(ticketId: string, content: string, sendMail?: boolean): Promise<void>;
  sendCustomerMessage(
    ticketId: string,
    content: string,
    hasRequester: boolean,
  ): Promise<'reply' | 'public_note' | 'failed'>;
  getTicketConversations(ticketId: string): Promise<TicketConversation[]>;
  testConnection(): Promise<{ ok: boolean; error?: string; endpoint?: string }>;
}
