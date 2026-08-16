'use client';

import { useActionState, useState } from 'react';
import { FormError } from '@/components/FormError';
import { MappingEditor } from '@/components/MappingEditor';
import { SubmitButton } from '@/components/SubmitButton';
import type { CategoryRecord } from '@/lib/categories';
import type { MerchantRuleRecord } from '@/lib/categorize/rules';
import type { ProfileRecord } from '@/lib/import/presets';
import type { ImportMapping } from '@/lib/import/mapping';
import type { ProfilesExportRow, RulesExportRow } from '@/lib/packs';
import { RulesPackPanel } from './rules-pack-panel';
import { ProfilesPackPanel } from './profiles-pack-panel';
import {
  archiveCategoryAction,
  createCategoryAction,
  deleteRuleAction,
  renameCategoryAction,
  saveProfileMappingAction,
  updateRuleAction,
  type ManagerState,
} from './actions';

const initial: ManagerState = {};

export function ManagersClient({
  categories,
  rules,
  profiles,
  rulesPackRows,
  profilePackRows,
}: {
  categories: CategoryRecord[];
  rules: MerchantRuleRecord[];
  profiles: ProfileRecord[];
  rulesPackRows: RulesExportRow[];
  profilePackRows: ProfilesExportRow[];
}) {
  const [createState, createCategory] = useActionState(createCategoryAction, initial);
  const [renameState, renameCategory] = useActionState(renameCategoryAction, initial);
  const [archiveState, archiveCategory] = useActionState(archiveCategoryAction, initial);
  const [ruleState, saveRule] = useActionState(updateRuleAction, initial);
  const [deleteState, removeRule] = useActionState(deleteRuleAction, initial);
  const [profileState, saveProfile] = useActionState(saveProfileMappingAction, initial);
  const [editing, setEditing] = useState<{ id: number; mapping: ImportMapping } | null>(null);

  const parents = categories.filter((c) => c.parentId === null);
  const label = (id: number | null) => {
    if (id === null) return '—';
    const category = categories.find((c) => c.id === id);
    if (!category) return '—';
    const parent = category.parentId ? categories.find((c) => c.id === category.parentId) : undefined;
    return parent ? `${parent.name} › ${category.name}` : category.name;
  };

  const notice =
    createState.message ?? renameState.message ?? archiveState.message ?? ruleState.message ?? deleteState.message ?? profileState.message;
  const error = createState.error ?? renameState.error ?? archiveState.error ?? ruleState.error ?? deleteState.error ?? profileState.error;

  return (
    <div className="flex flex-col gap-10">
      <h1 className="text-xl font-semibold">Categories, rules and import profiles</h1>
      <FormError message={error} />
      {notice ? <p className="text-sm text-green-700 dark:text-green-400">{notice}</p> : null}

      <section className="flex flex-col gap-3">
        <h2 className="font-medium">Categories</h2>
        <p className="text-xs text-slate-500">
          Categories are archived, never deleted — transactions, rules and budgets reference them permanently. Nesting is limited to two levels.
        </p>
        <form action={createCategory} className="flex flex-wrap items-end gap-2 text-sm">
          <input name="name" placeholder="New category" required className="rounded border px-2 py-1 dark:bg-slate-900" />
          <select name="parentId" className="rounded border px-2 py-1 dark:bg-slate-900">
            <option value="">Top level</option>
            {parents.map((parent) => (
              <option key={parent.id} value={parent.id}>{parent.name}</option>
            ))}
          </select>
          <SubmitButton>Add</SubmitButton>
        </form>
        <table className="w-full text-left text-sm">
          <tbody>
            {categories.map((category) => (
              <tr key={category.id} className="border-b border-slate-100 dark:border-slate-900">
                <td className="py-1" style={{ paddingLeft: category.parentId ? 20 : 0 }}>
                  <form action={renameCategory} className="flex items-center gap-1">
                    <input type="hidden" name="categoryId" value={category.id} />
                    <input name="name" defaultValue={category.name} className="rounded border px-2 py-1 text-xs dark:bg-slate-900" />
                    <button type="submit" className="text-xs underline">rename</button>
                  </form>
                </td>
                <td className="text-xs text-slate-500">{category.isIncome ? 'income' : 'spend'}</td>
                <td className="text-xs">{category.isArchived ? 'archived' : ''}</td>
                <td>
                  <form action={archiveCategory}>
                    <input type="hidden" name="categoryId" value={category.id} />
                    <input type="hidden" name="archived" value={category.isArchived ? '0' : '1'} />
                    <button type="submit" className="text-xs underline">{category.isArchived ? 'restore' : 'archive'}</button>
                  </form>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </section>

      <section className="flex flex-col gap-3">
        <h2 className="font-medium">Merchant rules ({rules.length})</h2>
        <form action={saveRule} className="flex flex-wrap items-end gap-2 text-sm">
          <input name="pattern" placeholder="Normalized merchant pattern" required className="rounded border px-2 py-1 dark:bg-slate-900" />
          <select name="matchType" className="rounded border px-2 py-1 dark:bg-slate-900">
            <option value="exact">exact</option>
            <option value="contains">contains</option>
          </select>
          <select name="ruleKind" className="rounded border px-2 py-1 dark:bg-slate-900">
            <option value="category">category</option>
            <option value="transfer">transfer</option>
            <option value="rename">rename</option>
            <option value="not_transfer">not a transfer (override)</option>
          </select>
          <select name="categoryId" className="rounded border px-2 py-1 dark:bg-slate-900">
            <option value="">(none — transfer, not_transfer and rename rules)</option>
            {categories.filter((c) => !c.isArchived).map((c) => (
              <option key={c.id} value={c.id}>{label(c.id)}</option>
            ))}
          </select>
          <input name="renameTo" placeholder="Display name (rename rules only)" className="rounded border px-2 py-1 dark:bg-slate-900" />
          <SubmitButton>Save rule</SubmitButton>
        </form>
        <p className="text-xs text-slate-500">
          A <strong>rename</strong> rule changes only what you see. Saving one applies it to every existing matching transaction that has not been
          renamed by hand; deleting one puts those rows back to the bank&apos;s wording. Transactions renamed individually are never touched.
          A <strong>not a transfer</strong> rule is an exact-match override that stops one merchant from being auto-flagged as a card payment.
        </p>
        <table className="w-full text-left text-sm">
          <thead>
            <tr className="border-b dark:border-slate-800">
              <th className="py-1">Pattern</th>
              <th>Match</th>
              <th>Kind</th>
              <th>Category</th>
              <th>Renames to</th>
              <th className="text-right">Hits</th>
              <th />
            </tr>
          </thead>
          <tbody>
            {rules.map((rule) => (
              <tr key={rule.id} className="border-b border-slate-100 dark:border-slate-900">
                <td className="py-1 font-mono text-xs">{rule.pattern}</td>
                <td className="text-xs">{rule.matchType}</td>
                <td className="text-xs">{rule.ruleKind}</td>
                <td className="text-xs">{rule.ruleKind === 'category' ? label(rule.categoryId) : '—'}</td>
                <td className="text-xs">{rule.renameTo ?? '—'}</td>
                <td className="text-right text-xs tabular-nums">{rule.hitCount}</td>
                <td>
                  <form action={removeRule}>
                    <input type="hidden" name="ruleId" value={rule.id} />
                    <button type="submit" className="text-xs underline">delete</button>
                  </form>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
        <RulesPackPanel rows={rulesPackRows} />
      </section>

      <section className="flex flex-col gap-3">
        <h2 className="font-medium">Import profiles</h2>
        <p className="text-xs text-slate-500">Built-in profiles are shared. Editing one saves a copy instead of changing the original.</p>
        <ul className="flex flex-col gap-2 text-sm">
          {profiles.map((profile) => (
            <li key={profile.id} className="border-b border-slate-100 py-2 dark:border-slate-900">
              <div className="flex items-center justify-between gap-2">
                <span>
                  {profile.name} <span className="text-xs text-slate-500">{profile.institution}{profile.isBuiltin ? ' · built-in' : ''}</span>
                </span>
                <button
                  type="button"
                  onClick={() => setEditing(editing?.id === profile.id ? null : { id: profile.id, mapping: profile.mapping })}
                  className="text-xs underline"
                >
                  {editing?.id === profile.id ? 'close' : 'edit mapping'}
                </button>
              </div>
              {editing?.id === profile.id ? (
                <form action={saveProfile} className="mt-2 flex flex-col gap-2">
                  <MappingEditor mapping={editing.mapping} onChange={(next) => setEditing({ id: profile.id, mapping: next })} />
                  <input type="hidden" name="profileId" value={profile.id} />
                  <input type="hidden" name="mapping" value={JSON.stringify(editing.mapping)} />
                  <SubmitButton>Save mapping</SubmitButton>
                </form>
              ) : null}
            </li>
          ))}
        </ul>
        <ProfilesPackPanel rows={profilePackRows} />
      </section>
    </div>
  );
}
