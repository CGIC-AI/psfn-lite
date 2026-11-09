"""Install the psfn_lite plugin into one Hermes profile, never with its Desktop half.

    python3 -I integrations/hermes/install_plugin.py <profile home>

The plugin's name is ``psfn_lite`` everywhere: the folder ``<home>/plugins/psfn_lite``, the
``name`` in ``plugin.yaml``, the ``name`` in ``dashboard/manifest.json`` (the backend is served at
``/api/plugins/psfn_lite/``) and the ``plugins.enabled`` entry. The tool refuses a source whose
names disagree.

Hermes Desktop hot-loads a ``desktop/plugin.js`` (or a root ``plugin.js``) from any plugin folder
under the Hermes root and every profile (apps/desktop/electron/desktop-plugins-root.ts). This tool
installs only the plugin and its dashboard backend. It checks for a Desktop half before it copies
and after, and it fails rather than leave one in the profile. The owner loads the Desktop half
into Hermes Desktop themselves (README, "The light Garden").

It replaces an earlier psfn_lite install in place and touches nothing else in the profile: no
config.yaml, no .env, no other plugin.
"""

import json
import shutil
import sys
from pathlib import Path

NAME = "psfn_lite"
DESKTOP_DIR = "desktop"
DESKTOP_ENTRY = "plugin.js"


class InstallError(RuntimeError):
    pass


def _declared_name(plugin_yaml: Path):
    try:
        lines = plugin_yaml.read_text(encoding="utf-8").splitlines()
    except OSError:
        return None
    for line in lines:
        if line.startswith("name:"):
            return line.split(":", 1)[1].strip().strip("\"'")
    return None


def manifest_names(source: Path) -> dict:
    """The plugin name each manifest declares."""
    return {
        "plugin.yaml": _declared_name(source / "plugin.yaml"),
        "dashboard/manifest.json": json.loads((source / "dashboard" / "manifest.json").read_text(encoding="utf-8")).get("name"),
    }


def desktop_halves(root: Path) -> list:
    """Every file or folder under ``root`` Hermes Desktop would load as a Desktop half."""
    if not root.exists():
        return []
    found = [path for path in root.rglob(DESKTOP_DIR) if path.is_dir()]
    found += [path for path in root.rglob(DESKTOP_ENTRY)]
    return sorted(set(found))


def _ignore(directory: str, entries: list) -> list:
    skipped = {"__pycache__", DESKTOP_DIR}
    return [entry for entry in entries if entry in skipped or entry == DESKTOP_ENTRY or entry.endswith(".pyc")]


def install(source: Path, home: Path) -> Path:
    source = Path(source).resolve()
    names = manifest_names(source)
    wrong = {where: name for where, name in names.items() if name != NAME}
    if source.name != NAME or wrong:
        raise InstallError(f"the plugin is named {NAME} in its folder and both manifests; found folder {source.name}, {names}")
    plugins = Path(home) / "plugins"
    target = plugins / NAME
    present = desktop_halves(target)
    if present:
        raise InstallError(f"refusing to install: {target} already holds a Desktop half ({', '.join(str(p) for p in present)}); remove it by hand first")
    plugins.mkdir(parents=True, exist_ok=True)
    if target.exists():
        if _declared_name(target / "plugin.yaml") != NAME:
            raise InstallError(f"refusing to replace {target}: it is not a psfn_lite install")
        shutil.rmtree(target)
    shutil.copytree(source, target, ignore=_ignore)
    copied = desktop_halves(target)
    if copied:
        shutil.rmtree(target)
        raise InstallError(f"a Desktop half was copied ({', '.join(str(p) for p in copied)}); the install was removed")
    return target


def main(argv: list) -> int:
    if len(argv) != 2:
        print(__doc__.strip().splitlines()[2].strip(), file=sys.stderr)
        return 2
    try:
        target = install(Path(__file__).resolve().parent / NAME, Path(argv[1]).expanduser())
    except InstallError as error:
        print(f"install refused: {error}", file=sys.stderr)
        return 1
    print(f"installed {target} (no Desktop half)")
    print(f"next: hermes -p <profile> plugins enable {NAME}  (adds {NAME} to plugins.enabled)")
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv))
