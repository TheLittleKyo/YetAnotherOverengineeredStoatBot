import { existsSync, mkdirSync, rmSync } from 'fs';
import { DATA_DIR, assertSafeDataDir } from './json-store.js';

assertSafeDataDir();

if (existsSync(DATA_DIR)) {
  try {
    rmSync(DATA_DIR, { recursive: true, force: true });
  } catch (error: any) {
    // The running bot holds data/bot.db open, and Windows refuses to delete an
    // open file. Say so instead of leaving half the directory behind silently.
    if (error?.code === 'EBUSY' || error?.code === 'EPERM') {
      console.error(`❌ Could not clear ${DATA_DIR}: a file is in use (${error.path || 'bot.db'}). Stop the bot first, then run this again.`);
      process.exit(1);
    }
    throw error;
  }
  console.log(`🧹 Cleared bot data directory: ${DATA_DIR}`);
} else {
  console.log(`ℹ️ Bot data directory did not exist: ${DATA_DIR}`);
}

mkdirSync(DATA_DIR, { recursive: true });
console.log('✅ Bot saved data has been reset.');
