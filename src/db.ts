import { PrismaPg } from '@prisma/adapter-pg'
import { PrismaClient } from './generated/prisma/client'

const connectionString = process.env.DATABASE_URL || '';

console.log(connectionString);

const adapter = new PrismaPg({ connectionString });

export const prisma = new PrismaClient({ adapter });


prisma.$connect().then(() => {
  console.log('Connected to database');
}).catch((error) => {
  console.error('Error connecting to database', error);
});
