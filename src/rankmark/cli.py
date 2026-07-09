"""rankmark CLI: embed / decode / attribute."""

import argparse
import gc
import json
import sys
from pathlib import Path

from .channel import ChannelParams
from .decoder import decode
from .encoder import embed
from .framing import PROFILES
from .heatmap import render_html, render_terminal
from .models import load_lens


def read_text(args) -> str:
    if args.file:
        return Path(args.file).read_text()
    if args.text:
        return args.text
    return sys.stdin.read()


def cmd_embed(args) -> int:
    lens = load_lens(args.model, args.dtype)
    params = ChannelParams(tau=args.tau, profile=args.profile, window=args.window,
                           temperature=args.temperature, top_k=args.top_k)
    payload = bytes.fromhex(args.payload)
    result = embed(lens, args.prompt, payload, params, max_new_tokens=args.max_tokens,
                   instruct=args.instruct)

    print(result.text)
    print(
        f"\n--- planted {result.bits_planted} bits ({result.frames_planted:.2f} frames), "
        f"{result.carrier_nulls} carrier-nulls, "
        f"retokenizes cleanly: {result.retokenizes_cleanly} ---",
        file=sys.stderr,
    )
    if not result.retokenizes_cleanly:
        print("warning: text does not re-tokenize to the generated ids; decode may fail",
              file=sys.stderr)

    if args.verify:
        check = decode(lens, result.text, params)
        ok = check.valid and check.payload == payload
        print(f"verify: {'payload recovered' if ok else 'FAILED'}", file=sys.stderr)
        if not ok:
            return 1
    if args.out:
        Path(args.out).write_text(
            json.dumps({"text": result.text, "payload": payload.hex(),
                        "tau": args.tau, "fingerprint": result.fingerprint}, indent=2)
        )
    return 0


def report(name: str, result, payload_hex: str | None) -> dict:
    return {
        "lens": name,
        "valid": result.valid,
        "payload": result.payload.hex() if result.payload else None,
        "carriers": len(result.bits),
        "frames": len(result.frames),
        "expected": payload_hex,
    }


def cmd_decode(args) -> int:
    text = read_text(args)
    lens = load_lens(args.model, args.dtype)
    params = ChannelParams(tau=args.tau, profile=args.profile, window=args.window)
    result = decode(lens, text, params)

    if args.heatmap:
        Path(args.heatmap).write_text(render_html(lens, result))
    if not args.quiet:
        render_terminal(lens, result)
    verdict = report(args.model, result, None)
    print(json.dumps(verdict, indent=2))
    return 0 if result.valid else 1


def cmd_attribute(args) -> int:
    text = read_text(args)
    params = ChannelParams(tau=args.tau, profile=args.profile, window=args.window)
    verdicts = []
    for name in args.pool.split(","):
        lens = load_lens(name.strip(), args.dtype)
        result = decode(lens, text, params)
        verdicts.append(report(name.strip(), result, None))
        del lens
        gc.collect()
    print(json.dumps(verdicts, indent=2))
    winners = [v for v in verdicts if v["valid"]]
    if len(winners) == 1:
        print(f"ATTRIBUTED: {winners[0]['lens']} (payload {winners[0]['payload']})",
              file=sys.stderr)
    elif winners:
        print(f"AMBIGUOUS: {[v['lens'] for v in winners]}", file=sys.stderr)
    else:
        print("UNATTRIBUTED", file=sys.stderr)
    return 0


def cmd_serve(args) -> int:
    import uvicorn

    from . import server

    server.configure([m.strip() for m in args.pool.split(",")])
    print(f"rankmark ui at http://127.0.0.1:{args.port}  (lenses: {args.pool})")
    uvicorn.run(server.app, host="127.0.0.1", port=args.port, log_level="warning")
    return 0


def main() -> int:
    parser = argparse.ArgumentParser(prog="rankmark", description=__doc__)
    parser.add_argument("--tau", type=float, default=2.0, help="entropy gate in nats")
    parser.add_argument("--dtype", choices=["float32", "bfloat16"], default=None)
    parser.add_argument("--profile", type=int, default=1, choices=sorted(PROFILES),
                        help="v2 profile: " + ", ".join(
                            f"{i}={p.name}" for i, p in sorted(PROFILES.items())))
    parser.add_argument("--window", type=int, default=None,
                        help="bound rank context to N tokens (survives head-truncation; "
                             "slower). default: full prefix")
    parser.add_argument("--temperature", type=float, default=0.0,
                        help="0 = greedy; >0 samples same-parity tokens, breaking "
                             "repetition loops (decode is unchanged)")
    parser.add_argument("--top-k", type=int, default=48, help="sampling window when temperature>0")
    sub = parser.add_subparsers(dest="command", required=True)

    p = sub.add_parser("embed", help="generate text with an embedded payload")
    p.add_argument("--model", required=True)
    p.add_argument("--prompt", required=True, help="completion prefix, or an instruction with --instruct")
    p.add_argument("--payload", required=True, help="hex bytes, e.g. a7")
    p.add_argument("--instruct", action="store_true",
                   help="treat --prompt as an instruction to a chat model; only the "
                        "reply is visible (needs --window)")
    p.add_argument("--max-tokens", type=int, default=300)
    p.add_argument("--verify", action="store_true", help="round-trip decode before exiting")
    p.add_argument("--out", help="write result json here")
    p.set_defaults(fn=cmd_embed)

    p = sub.add_parser("decode", help="read text back through one lens")
    p.add_argument("--model", required=True)
    p.add_argument("--text")
    p.add_argument("--file")
    p.add_argument("--heatmap", help="write an html heatmap here")
    p.add_argument("--quiet", action="store_true")
    p.set_defaults(fn=cmd_decode)

    p = sub.add_parser("attribute", help="decode under every lens in a pool")
    p.add_argument("--pool", required=True, help="comma-separated model names")
    p.add_argument("--text")
    p.add_argument("--file")
    p.set_defaults(fn=cmd_attribute)

    p = sub.add_parser("serve", help="run the local web UI")
    p.add_argument(
        "--pool",
        default="gpt2,Qwen/Qwen2.5-0.5B-Instruct,Qwen/Qwen2.5-3B,Qwen/Qwen2.5-3B-Instruct",
        help="lenses offered in the UI",
    )
    p.add_argument("--port", type=int, default=8765)
    p.set_defaults(fn=cmd_serve)

    args = parser.parse_args()
    return args.fn(args)


if __name__ == "__main__":
    sys.exit(main())
