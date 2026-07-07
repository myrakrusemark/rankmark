"""GLTR-style rendering of a decode: rank buckets as color, carriers marked."""

from rich.console import Console
from rich.text import Text

from .decoder import DecodeResult
from .models import Lens

BUCKET_STYLES = ("black on green3", "black on yellow3", "white on red3", "white on purple")
BUCKET_CSS = ("#c6efce", "#ffeb9c", "#ffc7ce", "#d9d2f5")
BUCKET_LABELS = ("rank<10", "<100", "<1000", "beyond")


def render_terminal(lens: Lens, result: DecodeResult, console: Console | None = None) -> None:
    console = console or Console()
    carriers = set(result.carrier_positions)
    text = Text()
    for o in result.obs:
        piece = lens.tokenizer.decode([o.token_id])
        style = BUCKET_STYLES[o.bucket]
        if o.pos in carriers:
            style += " underline"
        text.append(piece, style=style)
    console.print(text)
    legend = Text("  ")
    for style, label in zip(BUCKET_STYLES, BUCKET_LABELS):
        legend.append(f" {label} ", style=style)
        legend.append("  ")
    legend.append("underline = bit carrier", style="dim")
    console.print(legend)


def render_html(lens: Lens, result: DecodeResult, title: str = "rankmark decode") -> str:
    carriers = set(result.carrier_positions)
    spans = []
    for o in result.obs:
        piece = (
            lens.tokenizer.decode([o.token_id])
            .replace("&", "&amp;")
            .replace("<", "&lt;")
            .replace("\n", "<br>")
        )
        border = "border-bottom:2px solid #333;" if o.pos in carriers else ""
        tip = f"pos {o.pos} rank {o.rank} H {o.entropy:.2f}"
        spans.append(
            f'<span title="{tip}" style="background:{BUCKET_CSS[o.bucket]};{border}">{piece}</span>'
        )
    verdict = (
        f"checksum valid — payload {result.payload.hex()}" if result.valid else "no valid frame"
    )
    return (
        f"<!doctype html><meta charset='utf-8'><title>{title}</title>"
        f"<body style='font-family:monospace;line-height:2;max-width:800px;margin:2rem auto;'>"
        f"<h3>{title} — lens {result.fingerprint.get('model', '?')} — {verdict}</h3>"
        f"<p>{''.join(spans)}</p></body>"
    )
