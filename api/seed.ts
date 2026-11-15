import { VercelRequest, VercelResponse } from '@vercel/node';
import { PrismaClient } from '@prisma/client';

const prisma = new PrismaClient();

export default async function handler(req: VercelRequest, res: VercelResponse) {
  try {
    // 1. إنشاء الجدول فـ الداتابيز
    await prisma.$executeRaw`
      CREATE TABLE IF NOT EXISTS "Address" (
        "id" SERIAL PRIMARY KEY,
        "address" TEXT UNIQUE NOT NULL
      );
    `;

    // 2. العناوين للتجربة
    const addressesToAdd = [
      { address: "1A1zP1eP5QGefi2DMPTfTL5SLmv7DivfNa" },
      { address: "12c6DSiU4Rq3P4ZxziKxz8e55yx1nX8uN" },
      { address: "1HLoD9E4SDFFPDiYfNYnkBLQ85Y51J3Zb1" },
    ];

    // 3. تحميل العناوين
    await prisma.address.createMany({
      data: addressesToAdd,
      skipDuplicates: true,
    });

    // 4. تجربة البحث (محاكاة لما غادي يدير الـ Worker)
    const testAddressesToSearch = [
      "1A1zP1eP5QGefi2DMPTfTL5SLmv7DivfNa", // هادا كاين
      "1FakeAddressThatDoesNotExist12345",   // هادا ما كاينش
    ];

    const found = await prisma.address.findMany({
      where: {
        address: { in: testAddressesToSearch },
      },
      select: { address: true },
    });

    // 5. عرض النتيجة فـ الشاشة
    return res.status(200).send(`
      <h1>✅ Database Seeded Successfully!</h1>
      <p><strong>Addresses Added:</strong> ${addressesToAdd.length}</p>
      <hr />
      <h2>🔍 API Test Result:</h2>
      <p>We searched for 2 addresses (one real, one fake).</p>
      <p><strong>Found in Database:</strong> ${JSON.stringify(found, null, 2)}</p>
      <p style="color: green;">If you see the real address above, your API and Database are working 100%!</p>
    `);
  } catch (error: any) {
    console.error(error);
    return res.status(500).json({ error: error.message });
  }
}
