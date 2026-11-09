#!/usr/bin/env python3
"""Print the provenance tables of docs/provenance.md ("The extracted core").

Usage (from the repository root):

    python3 -I packages/companion/extraction/provenance-tables.py <donor git dir> [<rev>]

It compares Git blobs, never working-tree bytes: `git ls-tree -r HEAD` of
packages/companion/{src,config} against `git ls-tree -r <donor rev>` of the
donor's src and config (default rev: the donor commit in baseline.json). A file
with the donor's blob at the same path is "extracted unchanged", a file at a
donor path with another blob is "extracted with cuts", and a file at no donor
path is Lite. Entries name the records that explain each change
(extraction/cuts.tsv, modified-tests.tsv, deleted-tests.tsv, added-tests.tsv).
The cut table summarizes extraction/vendored-files.txt. The first line printed
is the summary sentence for the section header; commit first, since uncommitted
changes are not in HEAD.
"""
import collections
import json
import os
import subprocess
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
PACKAGE = os.path.dirname(HERE)
PREFIX = 'packages/companion/'


def ls_tree(git_dir, rev, paths, strip=''):
    out = subprocess.run(['git', '-C', git_dir, 'ls-tree', '-r', '-z', rev, '--', *paths],
                         check=True, capture_output=True, text=True).stdout
    blobs = {}
    for record in out.split('\0'):
        if not record:
            continue
        meta, path = record.split('\t', 1)
        _mode, kind, blob = meta.split()
        if kind == 'blob':
            blobs[path[len(strip):]] = blob
    return blobs


def rows(name):
    with open(os.path.join(HERE, name), encoding='utf-8') as handle:
        return [line.rstrip('\n').split('\t') for line in handle
                if line.strip() and not line.startswith('#')]


def seam_key(seam):
    numbers = tuple(int(part) for part in seam.split('.') if part.isdigit())
    return (0, numbers, seam) if numbers else (1, (), seam)


def main():
    if len(sys.argv) not in (2, 3):
        sys.exit(__doc__)
    donor_dir = sys.argv[1]
    if len(sys.argv) == 3:
        donor_rev = sys.argv[2]
    else:
        with open(os.path.join(PACKAGE, 'baseline.json'), encoding='utf-8') as handle:
            donor_rev = json.load(handle)['donor']['commit']
    repo = os.path.dirname(os.path.dirname(PACKAGE))
    lite = ls_tree(repo, 'HEAD', [PREFIX + 'src', PREFIX + 'config'], PREFIX)
    donor = ls_tree(donor_dir, donor_rev, ['src', 'config'])
    files = sorted(lite)
    changed = [f for f in files if f in donor and donor[f] != lite[f]]
    new = [f for f in files if f not in donor]
    changed_set, new_set = set(changed), set(new)
    unchanged = len(files) - len(changed) - len(new)

    cuts = rows('cuts.tsv')
    modified = {r[0] for r in rows('modified-tests.tsv')}
    deleted = {r[0] for r in rows('deleted-tests.tsv')}
    added = {r[0] for r in rows('added-tests.tsv')}

    def cut_seams(path):
        found = set()
        base = os.path.basename(path)
        parent = os.path.dirname(path).split('/')[-1]
        for row in cuts:
            site = row[1]
            if path in site or path.replace('src/', '', 1) in site:
                found.add(row[0])
            elif base in site and (parent in site or path in new_set):
                found.add(row[0])
        return sorted(found, key=seam_key)

    def changed_entry(path):
        parts = []
        seams = cut_seams(path)
        if seams:
            parts.append('cut: seam ' + ', '.join(seams) + ' (`extraction/cuts.tsv`)')
        if path in modified:
            parts.append('test edits recorded (`extraction/modified-tests.tsv`)')
        if path in deleted:
            parts.append('tests of cut scaffolding deleted (`extraction/deleted-tests.tsv`)')
        if path == 'src/test-support/postgres-test-harness.ts':
            parts.append('test profile override (docs/extraction.md, Modified donor files)')
        if not parts:
            parts.append('see `extraction/cuts.tsv`')
        return 'extracted from donor `%s`; %s' % (path, '; '.join(parts))

    def new_entry(path):
        if path.endswith('static-credential-vault.ts'):
            return ('Lite test support: donor `boundary/custody/credential-vault.ts:94-119`, '
                    'unchanged, over the credential contract (B7)')
        labels = []
        seams = cut_seams(path)
        if seams:
            labels.append('seam ' + ', '.join(seams) + ' (`extraction/cuts.tsv`)')
        if path in added:
            labels.append('a Lite test (`extraction/added-tests.tsv`)')
        return 'Lite, ' + '; '.join(labels) if labels else 'Lite'

    out = []
    emit = out.append
    emit(f'The tree has {len(files):,} files: {unchanged:,} extracted unchanged, '
         f'{len(changed):,} extracted with cuts, and {len(new):,} Lite.')
    emit('')
    dirs = collections.OrderedDict()
    for path in files:
        counts = dirs.setdefault(os.path.dirname(path), [0, 0, 0])
        counts[1 if path in changed_set else 2 if path in new_set else 0] += 1
    emit('### Extracted unchanged\n')
    emit('Every file counted here is byte-identical (the same Git blob) to the donor file at the '
         'same path. Where a directory also holds changed or Lite-new files, they are in the next '
         'two tables.\n')
    emit('| Lite path (under `packages/companion/`) | Entry |')
    emit('|---|---|')
    for directory, (same, edited, lite_new) in dirs.items():
        if same == 0:
            continue
        extra = []
        if edited:
            extra.append(f'{edited} changed')
        if lite_new:
            extra.append(f'{lite_new} Lite-new')
        tail = ('; ' + ', '.join(extra) + ' listed below') if extra else ''
        plural = 's' if same != 1 else ''
        emit(f'| `{directory}/` | extracted unchanged from donor `{directory}/` ({same} file{plural}{tail}) |')
    emit('\n### Extracted with cuts\n')
    emit('| Lite path (under `packages/companion/`) | Entry |')
    emit('|---|---|')
    for path in changed:
        emit(f'| `{path}` | {changed_entry(path)} |')
    emit('\n### Lite-new files in the extracted tree\n')
    emit('Ports, stubs and helpers a seam cut put in place of scaffolding (each named in '
         '`extraction/cuts.tsv`), the composition root and its boot proof, the operator automata '
         'rules (seam D), and test support. Not donor files.\n')
    emit('| Lite path (under `packages/companion/`) | Entry |')
    emit('|---|---|')
    for path in new:
        emit(f'| `{path}` | {new_entry(path)} |')
    areas = collections.Counter()
    for row in rows('vendored-files.txt'):
        if row[0] in ('scaffolding', 'cut', 'source-text', 'test-support-deleted',
                      'asset-deleted', 'seed-deleted'):
            parts = row[1].split('/')
            key = '/'.join(parts[:3]) + '/' if len(parts) > 3 else row[1]
            areas[(key, row[0])] += 1
    emit('\n### Cut\n')
    emit('Donor files that were carried into the tree and deleted again in B7 '
         '(`extraction/vendored-files.txt` keeps one row per file), by donor area and kind. Donor '
         'files outside the closure that no extracted file imports were never copied (the closure '
         'is `extraction/closure-files.txt`).\n')
    emit('| Donor path | Entry |')
    emit('|---|---|')
    for (key, kind), count in sorted(areas.items()):
        emit(f'| `{key}` | cut ({kind}, {count} file{"s" if count != 1 else ""}) |')
    print('\n'.join(out))


if __name__ == '__main__':
    main()
