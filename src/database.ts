import { config as botConfig } from './config.js';
import { basename } from 'node:path';
import { dataFile, readJson as readJsonFile, registerDataFileHooks, writeJson as writeJsonFile } from './json-store.js';

type TicketRecord = Record<string, any>;
type TicketWithId = TicketRecord & { ticketId: string };

// A ticket belongs to `serverId`. Tickets created before the field existed have
// none; those are attributed to the configured default server.
function ticketMatchesServer(ticket: TicketRecord, serverId?: string): boolean {
  if (!serverId) return true;
  return (ticket.serverId || botConfig.serverId) === serverId;
}

const TICKETS_FILE = dataFile('tickets.json');
const COUNTER_FILE = dataFile('counter.json');
const TICKET_COOLDOWNS_FILE = dataFile('ticket-cooldowns.json');

// Every ticket command looks its ticket up, so the parsed file is kept in
// memory (this process is the only writer). A backup restore replaces the file,
// so the copy is dropped then.
let ticketsCache: Record<string, TicketRecord> | null = null;
registerDataFileHooks(basename(TICKETS_FILE), { reload: () => { ticketsCache = null; } });

function writeTickets(tickets: Record<string, TicketRecord>) {
  ticketsCache = tickets;
  writeJsonFile(TICKETS_FILE, tickets);
}

/**
 * Ticket Database Manager
 */
export const ticketDb = {
  /**
   * Get all tickets
   * @returns {Object} Map of ticketId to ticket data
   */
  getAll(): Record<string, TicketRecord> {
    if (!ticketsCache) ticketsCache = readJsonFile<Record<string, TicketRecord>>(TICKETS_FILE, {});
    return ticketsCache;
  },
  
  /**
   * Get a ticket by its ID
   * @param {string} ticketId - The ticket ID (e.g., "0001")
   * @returns {Object|null} Ticket data or null
   */
  getById(ticketId: string) {
    // Copies, so a caller editing its result cannot change the cached record.
    const ticket = this.getAll()[ticketId];
    return ticket ? { ...ticket } : null;
  },
  
  /**
   * Get a ticket by channel ID
   * @param {string} channelId - The Stoat channel ID
   * @returns {Object|null} Ticket data or null
   */
  getByChannelId(channelId: string): TicketWithId | null {
    const tickets = this.getAll() as Record<string, TicketRecord>;
    for (const [id, ticket] of Object.entries(tickets)) {
      if (ticket.channelId === channelId) {
        return { ...ticket, ticketId: id };
      }
    }
    return null;
  },
  
  /**
   * Create a new ticket
   * @param {Object} ticketData - Ticket information
   * @returns {Object} Created ticket with ID
   */
  create(ticketData: TicketRecord) {
    const tickets = this.getAll() as Record<string, TicketRecord>;
    const ticketId = this.getNextTicketId();
    
    const ticket = {
      ...ticketData,
      createdAt: new Date().toISOString(),
      status: 'open',
    };
    
    tickets[ticketId] = ticket;
    writeTickets(tickets);
    
    return { ticketId, ...ticket };
  },
  
  /**
   * Update a ticket
   * @param {string} ticketId - The ticket ID
   * @param {Object} updates - Fields to update
   * @returns {Object|null} Updated ticket or null
   */
  update(ticketId: string, updates: TicketRecord) {
    const tickets = this.getAll() as Record<string, TicketRecord>;
    if (!tickets[ticketId]) {
      return null;
    }
    
    tickets[ticketId] = {
      ...tickets[ticketId],
      ...updates,
      updatedAt: new Date().toISOString(),
    };
    
    writeTickets(tickets);
    return { ...tickets[ticketId] };
  },

  /**
   * Delete a ticket by ID
   * @param {string} ticketId - The ticket ID
   * @returns {boolean} True if deleted, false if not found
   */
  delete(ticketId: string) {
    const tickets = this.getAll() as Record<string, TicketRecord>;
    if (!tickets[ticketId]) {
      return false;
    }

    delete tickets[ticketId];
    writeTickets(tickets);
    return true;
  },
  
  /**
   * Get the next ticket ID (incremental)
   * @returns {string} Next ticket ID padded to 4 digits
   */
  getNextTicketId() {
    const counter = readJsonFile(COUNTER_FILE, { lastId: 0 });
    const next = (Number(counter.lastId) || 0) + 1;
    counter.lastId = next;
    writeJsonFile(COUNTER_FILE, counter);
    return String(next).padStart(4, '0');
  },
  
  /**
   * Get all open tickets
   * @returns {Array} Array of open tickets
   */
  getOpenTickets(serverId?: string): TicketWithId[] {
    const tickets = this.getAll() as Record<string, TicketRecord>;
    return Object.entries(tickets)
      .filter(([, ticket]) => ticket.status === 'open' && ticketMatchesServer(ticket, serverId))
      .map(([id, ticket]) => ({ ticketId: id, ...ticket }));
  },

  /**
   * Get all closed tickets
   * @returns {Array} Array of closed tickets
   */
  getClosedTickets(serverId?: string): TicketWithId[] {
    const tickets = this.getAll() as Record<string, TicketRecord>;
    return Object.entries(tickets)
      .filter(([, ticket]) => ticket.status === 'closed' && ticketMatchesServer(ticket, serverId))
      .map(([id, ticket]) => ({ ticketId: id, ...ticket }));
  },
};

/**
 * Tracks per-user ticket creation cooldown timestamps.
 */
export const ticketCooldownDb = {
  getAll(): Record<string, string> {
    return readJsonFile<Record<string, string>>(TICKET_COOLDOWNS_FILE, {});
  },

  getLastCreatedAt(userId: string): string | null {
    if (!userId) return null;
    const all = this.getAll();
    return all[userId] || null;
  },

  setLastCreatedAt(userId: string, isoTimestamp = new Date().toISOString()) {
    if (!userId) return;
    const all = this.getAll();
    all[userId] = isoTimestamp;
    writeJsonFile(TICKET_COOLDOWNS_FILE, all);
  },

  getRemainingMs(userId: string, cooldownMs: number, nowMs = Date.now()): number {
    if (!userId || !Number.isFinite(cooldownMs) || cooldownMs <= 0) {
      return 0;
    }

    const lastCreatedAt = this.getLastCreatedAt(userId);
    if (!lastCreatedAt) {
      return 0;
    }

    const lastMs = new Date(lastCreatedAt).getTime();
    if (!Number.isFinite(lastMs)) {
      return 0;
    }

    const elapsed = nowMs - lastMs;
    if (elapsed >= cooldownMs) {
      return 0;
    }

    return Math.max(0, cooldownMs - elapsed);
  },
};
