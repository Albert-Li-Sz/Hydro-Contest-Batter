import type { Context } from 'hydrooj';

const collections = ['xcpcio.certificates', 'xcpcio.certificates.issued', 'xcpcio.certificates.assets'] as const;

type LegacyCollections = Record<typeof collections[number], { _id: string }>;
declare module 'hydrooj' {
    interface Collections extends LegacyCollections {}
}

export async function removeRetiredCertificates(db: Context['db']) {
    // Hydro resolves installation-specific prefixes and collection mappings for these logical names.
    for (const name of collections) await db.collection(name).deleteMany({});
}
