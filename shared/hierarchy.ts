/** Longest permitted parent chain, counting the task itself. */
export const MAX_TASK_DEPTH = 32;

interface HierarchyRow { id: string; parent_id?: string | null; project_id: string | null }
export interface HierarchyProblem { index: number; message: string }

/**
 * Whole-set checks for a task hierarchy, used where rows arrive in bulk (import, restore): every
 * parent exists, shares the child's project, and no chain loops or runs deeper than the limit.
 * One problem per offending row, in row order.
 */
export function hierarchyProblems(rows: readonly HierarchyRow[]): HierarchyProblem[] {
  const byId = new Map(rows.map(row => [row.id, row] as const));
  const problems: HierarchyProblem[] = [];
  rows.forEach((row, index) => {
    const parentId = row.parent_id ?? null;
    if (parentId === null) return;
    const parent = byId.get(parentId);
    if (parentId === row.id) return void problems.push({ index, message: 'A task cannot be its own parent.' });
    if (!parent) return void problems.push({ index, message: `parent_id ${parentId} is not a task in this document.` });
    if ((parent.project_id ?? null) !== (row.project_id ?? null)) return void problems.push({ index, message: 'A subtask must be in the same project as its parent.' });
    let depth = 1;
    for (let at: HierarchyRow | undefined = parent; at !== undefined; at = at.parent_id ? byId.get(at.parent_id) : undefined) {
      depth++;
      if (at.id === row.id) return void problems.push({ index, message: 'The parent chain loops back to this task.' });
      if (depth > MAX_TASK_DEPTH + 1) return void problems.push({ index, message: `Tasks nest at most ${MAX_TASK_DEPTH} levels deep.` });
    }
    if (depth > MAX_TASK_DEPTH) problems.push({ index, message: `Tasks nest at most ${MAX_TASK_DEPTH} levels deep.` });
  });
  return problems;
}
