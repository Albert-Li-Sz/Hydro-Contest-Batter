import { ContestModel, ObjectId, type Context, type Tdoc } from 'hydrooj';

type ScheduleContest = Pick<Tdoc, 'endAt' | 'lockAt' | 'unlocked' | 'rule'>;

export function unfreezeAt(contest: ScheduleContest, minutes: number | null | undefined) {
    if (minutes == null || contest.rule !== 'acm' || !contest.lockAt || contest.unlocked) return null;
    return new Date(contest.endAt.getTime() + minutes * 60_000);
}

/** Claim due schedules in Mongo so the native unlock and its results snapshot run in the same worker. */
export function applyAutoUnfreeze(ctx: Context) {
    const settings = ctx.db.collection('xcpcio.enhanced.settings');
    const leaseMs = 60_000;
    async function check(now = new Date()) {
        const available = { $or: [{ unlockLeaseUntil: { $exists: false } }, { unlockLeaseUntil: { $lte: now } }] };
        const due = await settings.find({ unlockCheckAt: { $gt: new Date(0), $lte: now }, ...available })
            .sort({ unlockCheckAt: 1 }).limit(50).toArray();
        for (const doc of due) {
            const minutes = doc.settings.autoUnfreezeMinutes;
            const filter = { _id: doc._id, unlockCheckAt: doc.unlockCheckAt, 'settings.autoUnfreezeMinutes': minutes };
            const unlockLeaseUntil = new Date(Date.now() + leaseMs);
            const owned = { ...filter, unlockLeaseUntil };
            const claim = await settings.findOneAndUpdate({ ...filter, ...available }, { $set: { unlockLeaseUntil } }, { returnDocument: 'after' });
            if (!claim) continue;
            try {
                const slash = doc._id.lastIndexOf('/');
                const domain = doc._id.slice(0, slash);
                const tid = new ObjectId(doc._id.slice(slash + 1));
                const contest = await ContestModel.get(domain, tid);
                const at = contest && unfreezeAt(contest, minutes);
                if (at && at <= now && await settings.findOne(owned)) {
                    await ContestModel.unlockScoreboard(domain, tid);
                }
                await settings.updateOne(owned, { $set: { unlockCheckAt: at && at > now ? at : null } });
                await settings.updateOne({ _id: doc._id, unlockLeaseUntil }, { $unset: { unlockLeaseUntil: '' } });
            } catch {
                // A failed worker or transient database error is retried after the lease expires.
            }
        }
    }
    ctx.on('contest/edit', async (tdoc) => {
        const id = `${tdoc.domainId}/${tdoc.docId}`;
        const doc = await settings.findOne({ _id: id });
        if (doc?.settings.autoUnfreezeMinutes == null) return;
        const minutes = doc.settings.autoUnfreezeMinutes;
        await settings.updateOne({ _id: id, 'settings.autoUnfreezeMinutes': minutes }, { $set: { unlockCheckAt: unfreezeAt(tdoc, minutes) } });
    });
    ctx.on('app/started', async () => {
        await settings.createIndex({ unlockCheckAt: 1 }, { partialFilterExpression: { unlockCheckAt: { $type: 'date' } } });
        await check();
    });
    const timer = setInterval(() => { void check().catch(() => undefined); }, 10_000);
    timer.unref();
    ctx.effect(() => () => clearInterval(timer));
    return check;
}
