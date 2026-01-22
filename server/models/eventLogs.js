const prisma = require("../utils/prisma");

// Queue for batching event logs during bulk operations
let eventQueue = [];
let batchTimeout = null;

const EventLogs = {
  logEvent: async function (event, metadata = {}, userId = null, batch = false) {
    // If batching is requested, queue the event instead of writing immediately
    if (batch) {
      eventQueue.push({
        event,
        metadata: metadata ? JSON.stringify(metadata) : null,
        userId: userId ? Number(userId) : null,
        occurredAt: new Date(),
      });
      
      // Clear existing timeout and set new one
      if (batchTimeout) clearTimeout(batchTimeout);
      
      // Flush queue after 2 seconds of inactivity or when queue reaches 50 items
      if (eventQueue.length >= 50) {
        await this.flushEventQueue();
      } else {
        batchTimeout = setTimeout(() => this.flushEventQueue(), 2000);
      }
      
      return { eventLog: null, message: 'Queued for batch insert' };
    }
    
    try {
      // Set a timeout for the database operation to prevent hanging
      const timeoutPromise = new Promise((_, reject) => 
        setTimeout(() => reject(new Error('Event logging timeout')), 3000)
      );
      
      const createPromise = prisma.event_logs.create({
        data: {
          event,
          metadata: metadata ? JSON.stringify(metadata) : null,
          userId: userId ? Number(userId) : null,
          occurredAt: new Date(),
        },
      });
      
      const eventLog = await Promise.race([createPromise, timeoutPromise]);
      console.log(`\x1b[32m[Event Logged]\x1b[0m - ${event}`);
      return { eventLog, message: null };
    } catch (error) {
      // Silently fail for timeouts to avoid log spam during bulk operations
      if (error.message === 'Event logging timeout') {
        console.log(`\x1b[33m[Event Logging Skipped]\x1b[0m - ${event} (timeout)`);
      } else {
        console.error(
          `\x1b[31m[Event Logging Failed]\x1b[0m - ${event}`,
          error.message
        );
      }
      return { eventLog: null, message: error.message };
    }
  },

  flushEventQueue: async function () {
    if (eventQueue.length === 0) return;
    
    const eventsToInsert = [...eventQueue];
    eventQueue = [];
    
    try {
      // SQLite doesn't support createMany, use transaction with individual creates
      await prisma.$transaction(
        eventsToInsert.map(event => 
          prisma.event_logs.create({ data: event })
        )
      );
      console.log(`\x1b[32m[Batch Event Logged]\x1b[0m - ${eventsToInsert.length} events`);
    } catch (error) {
      console.error(`\x1b[31m[Batch Event Logging Failed]\x1b[0m`, error.message);
    }
  },

  getByEvent: async function (event, limit = null, orderBy = null) {
    try {
      const logs = await prisma.event_logs.findMany({
        where: { event },
        ...(limit !== null ? { take: limit } : {}),
        ...(orderBy !== null
          ? { orderBy }
          : { orderBy: { occurredAt: "desc" } }),
      });
      return logs;
    } catch (error) {
      console.error(error.message);
      return [];
    }
  },

  getByUserId: async function (userId, limit = null, orderBy = null) {
    try {
      const logs = await prisma.event_logs.findMany({
        where: { userId },
        ...(limit !== null ? { take: limit } : {}),
        ...(orderBy !== null
          ? { orderBy }
          : { orderBy: { occurredAt: "desc" } }),
      });
      return logs;
    } catch (error) {
      console.error(error.message);
      return [];
    }
  },

  where: async function (
    clause = {},
    limit = null,
    orderBy = null,
    offset = null
  ) {
    try {
      const logs = await prisma.event_logs.findMany({
        where: clause,
        ...(limit !== null ? { take: limit } : {}),
        ...(offset !== null ? { skip: offset } : {}),
        ...(orderBy !== null
          ? { orderBy }
          : { orderBy: { occurredAt: "desc" } }),
      });
      return logs;
    } catch (error) {
      console.error(error.message);
      return [];
    }
  },

  whereWithData: async function (
    clause = {},
    limit = null,
    offset = null,
    orderBy = null
  ) {
    const { User } = require("./user");

    try {
      const results = await this.where(clause, limit, orderBy, offset);

      for (const res of results) {
        const user = res.userId ? await User.get({ id: res.userId }) : null;
        res.user = user
          ? { username: user.username }
          : { username: "unknown user" };
      }

      return results;
    } catch (error) {
      console.error(error.message);
      return [];
    }
  },

  count: async function (clause = {}) {
    try {
      const count = await prisma.event_logs.count({
        where: clause,
      });
      return count;
    } catch (error) {
      console.error(error.message);
      return 0;
    }
  },

  delete: async function (clause = {}) {
    try {
      await prisma.event_logs.deleteMany({
        where: clause,
      });
      return true;
    } catch (error) {
      console.error(error.message);
      return false;
    }
  },
};

module.exports = { EventLogs };
