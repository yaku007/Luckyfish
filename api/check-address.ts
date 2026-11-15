import type { VercelRequest, VercelResponse } from '@vercel/node';
import { PrismaClient } from '@prisma/client';

const prisma = new PrismaClient();

export default async function handler(req: VercelRequest, res: VercelResponse) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  try {
    const { addresses } = req.body;

    if (!addresses || !Array.isArray(addresses)) {
      return res.status(400).json({ error: 'Invalid addresses' });
    }

    const foundAddresses = await prisma.address.findMany({
      where: {
        address: { in: addresses },
      },
      select: { address: true },
    });

    return res.status(200).json({
      matched: foundAddresses.map((a: { address: string }) => a.address),
    });
  } catch (error) {
    console.error(error);
    return res.status(500).json({ error: 'Server Error' });
  }
}
