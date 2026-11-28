// The migration steps, in order. Each one is a module with `name` ("v1->v2"), `from` (the schema it reads)
// and `run(collections)` -> StepResult, a pure function of the records (docs/MIGRATIONS.md).
import * as v1v2 from '../steps/v1-v2.js';

export const STEPS = [v1v2];
export const LATEST = STEPS[STEPS.length - 1].from + 1;

export function stepFrom(schema) {
  return STEPS.find((s) => s.from === schema);
}
