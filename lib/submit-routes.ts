import * as Hydro from 'hydrooj';
import type { JuryState } from './jury';
import { applySubmitApi } from './submit-api';

export function applySubmit(ctx: Hydro.Context, loadJury: (tdoc: Hydro.Tdoc) => Promise<JuryState | null>) {
    applySubmitApi(Hydro, ctx, loadJury);
}
