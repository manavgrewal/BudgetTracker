'use client';

import { useActionState, useState } from 'react';
import { FormError } from '@/components/FormError';
import { MappingEditor } from '@/components/MappingEditor';
import { SubmitButton } from '@/components/SubmitButton';
import { Card, CardBody, CardHeader } from '@/components/ui/Card';
import { Notice } from '@/components/ui/Notice';
import { PageHeader } from '@/components/ui/PageHeader';
import { TableWrap } from '@/components/ui/Table';
import { Field, inputClass, selectClass } from '@/components/ui/form';
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
  deleteProfileAction,
  deleteRuleAction,
  renameCategoryAction,
  saveProfileMappingAction,
  updateRuleAction,
  type ManagerState,
} from './actions';

const initial: ManagerState = {};

const rowInput = 'field-control w-auto px-2 py-1 text-xs';

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
  const [deleteProfileState, removeProfile] = useActionState(deleteProfileAction, initial);
  const [editing, setEditing] = useState<{ id: number; mapping: ImportMapping } | null>(null);
  const [deletingProfileId, setDeletingProfileId] = useState<number | null>(null);

  const parents = categories.filter((c) => c.parentId === null);
  const label = (id: number | null) => {
    if (id === null) return '—';
    const category = categories.find((c) => c.id === id);
    if (!category) return '—';
    const parent = category.parentId ? categories.find((c) => c.id === category.parentId) : undefined;
    return parent ? `${parent.name} › ${category.name}` : category.name;
  };

  const notice =
    createState.message ??
    renameState.message ??
    archiveState.message ??
    ruleState.message ??
    deleteState.message ??
    profileState.message ??
    deleteProfileState.message;
  const error =
    createState.error ??
    renameState.error ??
    archiveState.error ??
    ruleState.error ??
    deleteState.error ??
    profileState.error ??
    deleteProfileState.error;

  return (
    <div className="flex flex-col gap-6">
      <PageHeader
        eyebrow="Settings"
        title="Categories, rules and import profiles"
        description="How a line from the bank turns into something with a name and a category."
      />
      <FormError message={error} />
      {notice ? <Notice tone="success">{notice}</Notice> : null}

      <Card>
        <CardHeader
          title="Categories"
          description="Categories are archived, never deleted — transactions, rules and budgets reference them permanently. Nesting is limited to two levels."
        />
        <CardBody className="pb-4">
          <form action={createCategory} className="flex flex-wrap items-end gap-3">
            <Field label="New category">
              <input name="name" placeholder="Groceries" required className={inputClass} />
            </Field>
            <Field label="Parent">
              <select name="parentId" className={selectClass}>
                <option value="">Top level</option>
                {parents.map((parent) => (
                  <option key={parent.id} value={parent.id}>{parent.name}</option>
                ))}
              </select>
            </Field>
            <SubmitButton>Add</SubmitButton>
          </form>
        </CardBody>
        <TableWrap bare>
          <thead>
            <tr>
              <th scope="col">Name</th>
              <th scope="col">Kind</th>
              <th scope="col">State</th>
              <th scope="col" />
            </tr>
          </thead>
          <tbody>
            {categories.map((category) => (
              <tr key={category.id}>
                <td style={{ paddingLeft: category.parentId ? 36 : 16 }}>
                  <form action={renameCategory} className="flex items-center gap-1.5">
                    <input type="hidden" name="categoryId" value={category.id} />
                    <input
                      name="name"
                      defaultValue={category.name}
                      aria-label={`Rename ${category.name}`}
                      className={`w-44 ${rowInput}`}
                    />
                    <button type="submit" className="btn btn--ghost btn--sm px-2 text-xs">rename</button>
                  </form>
                </td>
                <td>
                  <span className={category.isIncome ? 'badge badge--green' : 'badge badge--slate'}>
                    {category.isIncome ? 'income' : 'spend'}
                  </span>
                </td>
                <td>{category.isArchived ? <span className="badge badge--muted">archived</span> : null}</td>
                <td className="text-right">
                  <form action={archiveCategory}>
                    <input type="hidden" name="categoryId" value={category.id} />
                    <input type="hidden" name="archived" value={category.isArchived ? '0' : '1'} />
                    <button type="submit" className="btn btn--ghost btn--sm px-2 text-xs">{category.isArchived ? 'restore' : 'archive'}</button>
                  </form>
                </td>
              </tr>
            ))}
          </tbody>
        </TableWrap>
      </Card>

      <Card>
        <CardHeader
          title={`Merchant rules (${rules.length})`}
          description={
            <>
              A <strong className="font-semibold text-ink">rename</strong> rule changes only what you see. Saving one applies it to every existing
              matching transaction that has not been renamed by hand; deleting one puts those rows back to the bank&apos;s wording. Transactions
              renamed individually are never touched. A <strong className="font-semibold text-ink">not a transfer</strong> rule is an exact-match
              override that stops one merchant from being auto-flagged as a card payment.
            </>
          }
        />
        <CardBody className="pb-4">
          <form action={saveRule} className="flex flex-wrap items-end gap-3">
            <Field label="Pattern">
              <input name="pattern" placeholder="Normalized merchant pattern" required className={inputClass} />
            </Field>
            <Field label="Match">
              <select name="matchType" className={selectClass}>
                <option value="exact">exact</option>
                <option value="contains">contains</option>
              </select>
            </Field>
            <Field label="Kind">
              <select name="ruleKind" className={selectClass}>
                <option value="category">category</option>
                <option value="transfer">transfer</option>
                <option value="rename">rename</option>
                <option value="not_transfer">not a transfer (override)</option>
              </select>
            </Field>
            <Field label="Category">
              <select name="categoryId" className={selectClass}>
                <option value="">(none — transfer, not_transfer and rename rules)</option>
                {categories.filter((c) => !c.isArchived).map((c) => (
                  <option key={c.id} value={c.id}>{label(c.id)}</option>
                ))}
              </select>
            </Field>
            <Field label="Renames to">
              <input name="renameTo" placeholder="Display name (rename rules only)" className={inputClass} />
            </Field>
            <SubmitButton>Save rule</SubmitButton>
          </form>
        </CardBody>
        <TableWrap bare>
          <thead>
            <tr>
              <th scope="col">Pattern</th>
              <th scope="col">Match</th>
              <th scope="col">Kind</th>
              <th scope="col">Category</th>
              <th scope="col">Renames to</th>
              <th scope="col" className="text-right">Hits</th>
              <th scope="col" />
            </tr>
          </thead>
          <tbody>
            {rules.map((rule) => (
              <tr key={rule.id}>
                <td className="font-mono text-xs text-ink">{rule.pattern}</td>
                <td className="text-xs text-muted">{rule.matchType}</td>
                <td className="text-xs"><span className="badge badge--slate">{rule.ruleKind}</span></td>
                <td className="text-xs text-muted">{rule.ruleKind === 'category' ? label(rule.categoryId) : '—'}</td>
                <td className="text-xs text-muted">{rule.renameTo ?? '—'}</td>
                <td className="tabnum text-right text-xs text-muted">{rule.hitCount}</td>
                <td className="text-right">
                  <form action={removeRule}>
                    <input type="hidden" name="ruleId" value={rule.id} />
                    <button type="submit" className="btn btn--ghost btn--sm px-2 text-xs">delete</button>
                  </form>
                </td>
              </tr>
            ))}
          </tbody>
        </TableWrap>
        <CardBody className="pt-4">
          <RulesPackPanel rows={rulesPackRows} />
        </CardBody>
      </Card>

      <Card>
        <CardHeader
          title="Import profiles"
          description="Built-in profiles are shared. Editing one saves a copy instead of changing the original."
        />
        <ul className="border-t border-line text-sm">
          {profiles.map((profile) => (
            <li key={profile.id} className="border-b border-line px-5 py-3 last:border-b-0 sm:px-6">
              <div className="flex flex-wrap items-center justify-between gap-2">
                <span>
                  <span className="font-medium text-ink">{profile.name}</span>{' '}
                  <span className="text-xs text-subtle">{profile.institution}{profile.isBuiltin ? ' · built-in' : ''}</span>
                </span>
                <div className="flex items-center gap-2">
                  <button
                    type="button"
                    onClick={() => setEditing(editing?.id === profile.id ? null : { id: profile.id, mapping: profile.mapping })}
                    className="btn btn--ghost btn--sm text-xs"
                  >
                    {editing?.id === profile.id ? 'close' : 'edit mapping'}
                  </button>
                  {profile.isBuiltin ? null : (
                    <button
                      type="button"
                      onClick={() => setDeletingProfileId(profile.id)}
                      className="btn btn--ghost btn--sm money-neg text-xs"
                    >
                      delete
                    </button>
                  )}
                </div>
              </div>
              {deletingProfileId === profile.id ? (
                <div className="mt-3 flex flex-col gap-3 rounded-md border border-negative-soft p-3">
                  <p className="text-sm text-ink">
                    Delete <strong className="font-semibold">{profile.name}</strong>? This cannot be undone. A
                    profile still used by an account or a past import cannot be deleted.
                  </p>
                  <form action={removeProfile} className="flex gap-2">
                    <input type="hidden" name="profileId" value={profile.id} />
                    <SubmitButton variant="danger" size="sm">Delete permanently</SubmitButton>
                    <button type="button" onClick={() => setDeletingProfileId(null)} className="btn btn--secondary btn--sm">
                      Cancel
                    </button>
                  </form>
                </div>
              ) : null}
              {editing?.id === profile.id ? (
                <form action={saveProfile} className="mt-3 flex flex-col gap-3">
                  <MappingEditor mapping={editing.mapping} onChange={(next) => setEditing({ id: profile.id, mapping: next })} />
                  <input type="hidden" name="profileId" value={profile.id} />
                  <input type="hidden" name="mapping" value={JSON.stringify(editing.mapping)} />
                  <SubmitButton className="w-fit">Save mapping</SubmitButton>
                </form>
              ) : null}
            </li>
          ))}
        </ul>
        <CardBody className="pt-4">
          <ProfilesPackPanel rows={profilePackRows} />
        </CardBody>
      </Card>
    </div>
  );
}
