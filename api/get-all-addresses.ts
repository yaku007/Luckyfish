import { VercelRequest, VercelResponse } from '@vercel/node';
import { PrismaClient } from '@prisma/client';

const prisma = new PrismaClient();

export default async function handler(req: VercelRequest, res: VercelResponse) {
  try {
    const addresses = await prisma.address.findMany({
      select: { address: true },
    });
    return res.status(200).json({
      addresses: addresses.map(a => a.address),
    });
  } catch (error: any) {
    return res.status(500).json({ error: error.message });
  }
}
