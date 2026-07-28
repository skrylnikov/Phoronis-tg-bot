import { PrismaPg } from '@prisma/adapter-pg';
import { PrismaClient } from '../generated/prisma/client';

const connectionString = process.env.DATABASE_URL;

if (!connectionString) {
  throw new Error('DATABASE_URL is required');
}

const prisma = new PrismaClient({
  adapter: new PrismaPg({ connectionString }),
});
const deadline = Date.now() + 10 * 60 * 1000;
let ready = false;

try {
  while (Date.now() < deadline) {
    const extensions = await prisma.$queryRaw<Array<{ installed: boolean }>>`
      SELECT EXISTS (
        SELECT 1 FROM pg_extension WHERE extname = 'vector'
      ) AS installed
    `;

    if (extensions[0]?.installed) {
      console.log('PostgreSQL vector extension is ready');
      ready = true;
      break;
    }

    console.log('Waiting for PostgreSQL vector extension');
    await Bun.sleep(2_000);
  }

  if (!ready) {
    throw new Error('Timed out waiting for PostgreSQL vector extension');
  }
} finally {
  await prisma.$disconnect();
}
