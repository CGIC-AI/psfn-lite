# lite-companion

The PSFN companion core: the components that hold the companion's inner life
(emotion, self-model, intention, identity, memory, scheduler, sessions,
contacts, automata, subagents, journals), extracted path-preserving from the
donor `psfn-framework` at `e6a9546051f4e92bf7218b133b4523ac53a797c0`.
`src/<path>` here is donor `src/<path>`, so relative imports are unchanged.

The extraction is in progress. `extraction/vendored-files.txt` lists the donor
scaffolding files carried temporarily so the tree compiles and its tests run
before the seams are cut; see `docs/extraction.md` at the repository root for
the record (closure, baseline, seams, deleted tests, package changes).

`config/` holds the donor's seed files, which the runtime and the tests read
from the working directory.

### Self-Direction Tool Surfaces

The donor tool surfaces for the self-direction faculties, kept verbatim from
the donor README (the faculty tests check these rows):

| Faculty | Direct tool surface |
| --- | --- |
| **North Star** | `north_star` (unified aspiration surface) |
| **Values** | `orient action=values_list|values_add|values_update` |
