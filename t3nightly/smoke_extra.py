from pathlib import Path

from .gate_proc import CheckFailed, clean_env, run

STORIES = Path(__file__).resolve().with_name("smoke_stories")


def story_step(path):
    def body(ctx, deadline):
        out = ctx.out / "stories" / path.stem
        out.mkdir(parents=True, exist_ok=True)
        code, text = run([ctx.node, str(path), str(ctx.tree), str(ctx.home), str(out)], ctx.log(path.stem), deadline, cwd=str(ctx.work), env=clean_env({"T3_SMOKE_CLI": ctx.t3, "T3_SMOKE_ORIGIN": ctx.origin, "T3_SMOKE_VERSION": ctx.version}))
        if code != 0:
            raise CheckFailed("story %s exited %d: %s" % (path.name, code, (text.strip().splitlines() or [""])[-1][:300]))
        return (text.strip().splitlines() or ["passed"])[-1][:300]

    return (path.stem, 600, body)


def story_steps():
    return [story_step(path) for path in sorted(STORIES.glob("*.mjs"))]
