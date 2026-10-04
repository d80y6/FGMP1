#!/usr/bin/env python3
"""
FGMP Architecture Diagram Generator
====================================
Generates two professional diagrams for the Arabic technical proposal:

1. 28-arch-diagram.png    — 6-layer system architecture diagram
2. 28-dataflow-diagram.png — Alarm-to-resolution data flow / sequence diagram

Palette: GO-1 Graphite Orange
- Background:  #1A2330 (dark graphite)
- Accent:      #D4875A (orange)
- Text:        #FFFFFF (white on dark)
- Light surf.: #F8F0EB (warm cream)

Arabic text is properly shaped (contextual forms) and reordered (RTL) via
arabic_reshaper + python-bidi before being passed to matplotlib. Font: FreeSerif
(the only widely available Arabic-capable TTF on this sandbox).
"""
import os
import matplotlib
matplotlib.use("Agg")
import matplotlib.pyplot as plt
from matplotlib.patches import FancyBboxPatch, FancyArrowPatch, Rectangle
from matplotlib import font_manager as fm
import arabic_reshaper
from bidi.algorithm import get_display

# ----------------------------------------------------------------------------
# CONFIG
# ----------------------------------------------------------------------------
OUT_DIR = "/home/z/my-project/download/qa-28"
os.makedirs(OUT_DIR, exist_ok=True)

# GO-1 Graphite Orange palette
BG       = "#1A2330"
ACCENT   = "#D4875A"
WHITE    = "#FFFFFF"
CREAM    = "#F8F0EB"
MUTED    = "#B0B8C0"
DARK_TX  = "#1A2330"
DIM      = "#3A4858"

# Font — FreeSerif has full Arabic glyph coverage on this sandbox
FONT_PATH = "/usr/share/fonts/truetype/freefont/FreeSerif.ttf"
FONT_BOLD = "/usr/share/fonts/truetype/freefont/FreeSerifBold.ttf"
fp       = fm.FontProperties(fname=FONT_PATH)
fp_bold  = fm.FontProperties(fname=FONT_BOLD)
fm.fontManager.addfont(FONT_PATH)
fm.fontManager.addfont(FONT_BOLD)


def ar(text):
    """Reshape + bidi-reorder Arabic text for matplotlib rendering."""
    return get_display(arabic_reshaper.reshape(text))


# ============================================================================
# DIAGRAM 1 — 6-LAYER SYSTEM ARCHITECTURE
# ============================================================================
def build_architecture_diagram():
    fig, ax = plt.subplots(figsize=(16, 10), dpi=100)
    fig.patch.set_facecolor(BG)
    ax.set_facecolor(BG)
    ax.set_xlim(0, 1600)
    ax.set_ylim(0, 1000)
    ax.axis("off")

    # ---- Title bar ----
    ax.add_patch(Rectangle((0, 940), 1600, 60, facecolor=ACCENT, edgecolor="none"))
    ax.text(800, 970, ar("الشكل (3): الهيكل العام لمنظومة FGMP — مخطط الطبقات الست وتدفّق البيانات"),
            ha="center", va="center", color=WHITE, fontproperties=fp_bold, fontsize=15)

    # ---- 6 Layers (top→bottom in figure = layer 1→6) ----
    # Each layer: dict with arabic label, english label, boxes list
    layers = [
        {
            "num":   1,
            "ar":    "الطبقة 1: الحساسات",
            "en":    "LAYER 1 — SENSORS",
            "boxes": [
                ("حساس مستوى\nالوقود",         "Fuel Level Sensor"),
                ("متحكّم\nالمولّد",              "Generator Controller"),
                ("حساس\nالبطارية",              "Battery Sensor"),
                ("الحساس\nالبيئي",              "Environmental Sensor"),
            ],
        },
        {
            "num":   2,
            "ar":    "الطبقة 2: بوابة الموقع",
            "en":    "LAYER 2 — SITE GATEWAY",
            "boxes": [
                ("جهاز تجميع البيانات (Data Collection Controller)",
                 "Per-site controller — aggregates sensors"),
            ],
        },
        {
            "num":   3,
            "ar":    "الطبقة 3: شبكة النقل",
            "en":    "LAYER 3 — NETWORK",
            "boxes": [
                ("شبكة بيانات 3G / 4G",
                 "High-speed data"),
                ("رسائل قصيرة SMS",
                 "Wide coverage fallback"),
                ("ربط مختلط\n(Hybrid)",
                 "Resilient transport"),
            ],
        },
        {
            "num":   4,
            "ar":    "الطبقة 4: الخادم المركزي",
            "en":    "LAYER 4 — CENTRAL SERVER",
            "boxes": [
                ("SCDTS",  "Sensor Control"),
                ("SDC",    "Data Collection"),
                ("SDA",    "Data Analysis & Alarms"),
                ("SMS",    "Notification Service"),
            ],
        },
        {
            "num":   5,
            "ar":    "الطبقة 5: قاعدة البيانات",
            "en":    "LAYER 5 — DATABASE",
            "boxes": [
                ("قاعدة بيانات المنظومة — نسخ احتياطي يومي تلقائي",
                 "Modern secure DB with daily backup"),
            ],
        },
        {
            "num":   6,
            "ar":    "الطبقة 6: واجهة المستخدم",
            "en":    "LAYER 6 — USER INTERFACE",
            "boxes": [
                ("لوحة الويب",      "Web Dashboard"),
                ("التطبيق الجوال",   "Mobile App"),
                ("تنبيهات SMS / البريد", "SMS / Email Alerts"),
            ],
        },
    ]

    # Layout: 6 layer strips between y=110 and y=930, each ~120px tall + 10px gap
    layer_top    = 920
    layer_height = 122
    layer_gap    = 14
    x_margin     = 60
    layer_band_w = 1600 - 2 * x_margin
    label_band_w = 220
    boxes_band_x = x_margin + label_band_w + 20
    boxes_band_w = layer_band_w - label_band_w - 20

    layer_centers_y = []

    for i, layer in enumerate(layers):
        y_top    = layer_top - i * (layer_height + layer_gap)
        y_bot    = y_top - layer_height
        y_center = (y_top + y_bot) / 2
        layer_centers_y.append(y_center)

        # ---- Layer label band (right side for RTL) ----
        ax.add_patch(FancyBboxPatch(
            (x_margin, y_bot), label_band_w, layer_height,
            boxstyle="round,pad=0,rounding_size=6",
            facecolor=ACCENT, edgecolor="none",
        ))
        ax.text(x_margin + label_band_w / 2, y_center + 14,
                ar(layer["ar"]),
                ha="center", va="center", color=WHITE,
                fontproperties=fp_bold, fontsize=13)
        ax.text(x_margin + label_band_w / 2, y_center - 18,
                layer["en"],
                ha="center", va="center", color=WHITE,
                fontproperties=fp, fontsize=9, alpha=0.95)

        # ---- Boxes inside layer ----
        n = len(layer["boxes"])
        gap_x = 18
        box_w = (boxes_band_w - (n - 1) * gap_x) / n
        for j, (ar_label, en_label) in enumerate(layer["boxes"]):
            bx = boxes_band_x + j * (box_w + gap_x)
            by = y_bot + 8
            bh = layer_height - 16
            # Subtle dim band behind boxes
            ax.add_patch(FancyBboxPatch(
                (bx, by), box_w, bh,
                boxstyle="round,pad=0,rounding_size=5",
                facecolor=CREAM, edgecolor=ACCENT, linewidth=1.2,
            ))
            # Top accent stripe
            ax.add_patch(Rectangle((bx, by + bh - 5), box_w, 5,
                                   facecolor=ACCENT, edgecolor="none"))
            # Arabic label (primary, larger)
            ax.text(bx + box_w / 2, by + bh * 0.60,
                    ar(ar_label),
                    ha="center", va="center", color=DARK_TX,
                    fontproperties=fp_bold, fontsize=12)
            # English label (secondary, smaller)
            ax.text(bx + box_w / 2, by + bh * 0.22,
                    en_label,
                    ha="center", va="center", color=DARK_TX,
                    fontproperties=fp, fontsize=9, alpha=0.85)

    # ---- Vertical data-flow arrows between layers ----
    arrow_x = x_margin + label_band_w / 2
    for i in range(len(layers) - 1):
        y_from = layer_centers_y[i] - layer_height / 2 - 2
        y_to   = layer_centers_y[i + 1] + layer_height / 2 + 2
        # Down arrow (control commands flowing down)
        arr = FancyArrowPatch(
            (arrow_x - 18, y_from), (arrow_x - 18, y_to),
            arrowstyle="-|>", mutation_scale=15,
            color=ACCENT, linewidth=1.6, alpha=0.85,
        )
        ax.add_patch(arr)
        # Up arrow (telemetry / data flowing up)
        arr2 = FancyArrowPatch(
            (arrow_x + 18, y_to), (arrow_x + 18, y_from),
            arrowstyle="-|>", mutation_scale=15,
            color=MUTED, linewidth=1.4, alpha=0.75,
        )
        ax.add_patch(arr2)

    # ---- Legend (bottom-left) ----
    legend_y = 70
    # Down arrow legend
    ax.add_patch(FancyArrowPatch(
        (x_margin + 30, legend_y + 20), (x_margin + 30, legend_y - 4),
        arrowstyle="-|>", mutation_scale=12, color=ACCENT, linewidth=1.6,
    ))
    ax.text(x_margin + 50, legend_y + 8,
            ar("أوامر التحكم (نزول)"),
            ha="left", va="center", color=WHITE,
            fontproperties=fp, fontsize=11)
    # Up arrow legend
    ax.add_patch(FancyArrowPatch(
        (x_margin + 320, legend_y - 4), (x_margin + 320, legend_y + 20),
        arrowstyle="-|>", mutation_scale=12, color=MUTED, linewidth=1.4,
    ))
    ax.text(x_margin + 340, legend_y + 8,
            ar("تدفّق البيانات والقياسات (صعود)"),
            ha="left", va="center", color=WHITE,
            fontproperties=fp, fontsize=11)

    # ---- Footer caption ----
    ax.text(800, 30,
            ar("منظومة FGMP — مراقبة وإدارة الوقود والتحكم بالمولّدات  •  شركة اليمن للموبايل"),
            ha="center", va="center", color=MUTED,
            fontproperties=fp, fontsize=10, alpha=0.85)

    plt.subplots_adjust(left=0, right=1, top=1, bottom=0)
    out_path = os.path.join(OUT_DIR, "28-arch-diagram.png")
    plt.savefig(out_path, dpi=100, facecolor=BG, bbox_inches="tight", pad_inches=0.1)
    plt.close(fig)
    print(f"✓ Architecture diagram saved: {out_path}")
    return out_path


# ============================================================================
# DIAGRAM 2 — DATA FLOW / SEQUENCE (ALARM → RESOLUTION)
# ============================================================================
def build_dataflow_diagram():
    fig, ax = plt.subplots(figsize=(16, 10), dpi=100)
    fig.patch.set_facecolor(BG)
    ax.set_facecolor(BG)
    ax.set_xlim(0, 1600)
    ax.set_ylim(0, 1000)
    ax.axis("off")

    # ---- Title bar ----
    ax.add_patch(Rectangle((0, 940), 1600, 60, facecolor=ACCENT, edgecolor="none"))
    ax.text(800, 970,
            ar("الشكل (6): مخطط تدفّق البيانات — من اكتشاف الإنذار حتى الاستجابة والحل"),
            ha="center", va="center", color=WHITE,
            fontproperties=fp_bold, fontsize=15)

    # ---- 5 swimlane actors ----
    actors = [
        ("الموقع\n(الحساسات)",        "SITE\n(Sensors)",       160),
        ("خدمة تجميع\nالبيانات SDC",  "SDC\nData Collector",   440),
        ("خدمة تحليل\nالبيانات SDA",  "SDA\nAnalysis Engine",  720),
        ("خدمة الرسائل\nSMS",         "SMS\nNotifier",        1000),
        ("المشغّل /\nمهندس الصيانة",   "Operator /\nField Eng.", 1280),
    ]

    # Lane backgrounds (alternating subtle dim)
    lane_top  = 880
    lane_bot  = 110
    lane_w    = 240
    lane_gap  = 20
    lane_xs   = []
    for i, (ar_label, en_label, x_center) in enumerate(actors):
        x_left = x_center - lane_w / 2
        lane_xs.append(x_center)
        # Lane background
        bg_color = "#222C3C" if i % 2 == 0 else "#1F2836"
        ax.add_patch(Rectangle(
            (x_left, lane_bot), lane_w, lane_top - lane_bot,
            facecolor=bg_color, edgecolor="none", alpha=0.85,
        ))
        # Lane header
        ax.add_patch(FancyBboxPatch(
            (x_left, lane_top), lane_w, 38,
            boxstyle="round,pad=0,rounding_size=4",
            facecolor=ACCENT, edgecolor="none",
        ))
        ax.text(x_center, lane_top + 24,
                ar(ar_label),
                ha="center", va="center", color=WHITE,
                fontproperties=fp_bold, fontsize=12)
        ax.text(x_center, lane_top + 8,
                en_label,
                ha="center", va="center", color=WHITE,
                fontproperties=fp, fontsize=9, alpha=0.92)
        # Lane vertical guide line (dashed)
        ax.plot([x_center, x_center], [lane_bot, lane_top],
                color=DIM, linewidth=0.8, linestyle="--", alpha=0.6)

    # ---- Steps (sequence of events) ----
    # Each step: (from_actor_idx, to_actor_idx, y, ar_label, en_label, color, side='right'/'left')
    steps = [
        # Step 1: Sensors → SDC (continuous telemetry)
        (0, 1, 820,
         "١. بثّ القياسات اللحظية (مستوى الوقود، حالة المولّد، جهد البطارية)",
         "1. Stream telemetry (fuel level, gen status, battery V)",
         MUTED, "above"),
        # Step 2: SDC → SDA
        (1, 2, 700,
         "٢. بيانات مُتحقَّق منها ومُعالَجة → تسليم إلى خدمة التحليل",
         "2. Validated & processed data → handoff to SDA",
         MUTED, "above"),
        # Step 3: SDA self-loop (alarm detected)
        (2, 2, 580,
         "٣. اكتشاف حدث غير اعتيادي → إنشاء إنذار (L1/L2/L3)",
         "3. Anomaly detected → raise alarm (L1/L2/L3)",
         ACCENT, "loop"),
        # Step 4: SDA → SMS
        (2, 3, 460,
         "٤. توجيه طلب الإشعار (مع أولوية وتصنيف)",
         "4. Notification request (with priority + severity)",
         ACCENT, "above"),
        # Step 5: SMS → Operator
        (3, 4, 340,
         "٥. إرسال SMS / بريد إلكتروني فوري إلى المشغّل المعتمد",
         "5. Instant SMS / email to on-call operator",
         ACCENT, "above"),
        # Step 6: Operator → SDC (acknowledge)
        (4, 1, 240,
         "٦. الإقرار بالاستلام + إصدار أمر تحكّم عن بُعد (تشغيل/إيقاف مولّد)",
         "6. Acknowledge + issue remote control command",
         "#7AB8A0", "below"),
        # Step 7: SDC → Sensors (control command)
        (1, 0, 160,
         "٧. تمرير الأمر إلى جهاز التحكم بالموقع → تنفيذ وتأكيد الحل",
         "7. Forward command to site controller → resolve + confirm",
         "#7AB8A0", "below"),
    ]

    for from_i, to_i, y, ar_label, en_label, color, side in steps:
        x_from = lane_xs[from_i]
        x_to   = lane_xs[to_i]

        if side == "loop":
            # Self-loop for SDA
            loop_x = x_from + 80
            ax.add_patch(FancyArrowPatch(
                (x_from + 20, y + 10), (x_from + 20, y - 10),
                connectionstyle=f"arc3,rad=-0.8",
                arrowstyle="-|>", mutation_scale=14,
                color=color, linewidth=1.8,
            ))
            ax.text(loop_x + 70, y,
                    ar(ar_label),
                    ha="left", va="center", color=color,
                    fontproperties=fp_bold, fontsize=11)
            ax.text(loop_x + 70, y - 16,
                    en_label,
                    ha="left", va="center", color=MUTED,
                    fontproperties=fp, fontsize=9, alpha=0.85)
        else:
            # Horizontal arrow between lanes
            arr = FancyArrowPatch(
                (x_from, y), (x_to, y),
                arrowstyle="-|>", mutation_scale=15,
                color=color, linewidth=1.8,
            )
            ax.add_patch(arr)
            # Label above or below the arrow
            label_y = y + 14 if side == "above" else y - 14
            ax.text((x_from + x_to) / 2, label_y,
                    ar(ar_label),
                    ha="center", va="center", color=color,
                    fontproperties=fp_bold, fontsize=11)
            ax.text((x_from + x_to) / 2, label_y - 14,
                    en_label,
                    ha="center", va="center", color=MUTED,
                    fontproperties=fp, fontsize=9, alpha=0.85)
            # Step number circle
            step_num = ar_label.split(" ")[0].replace("١", "1").replace("٢", "2").replace("٣", "3").replace("٤", "4").replace("٥", "5").replace("٦", "6").replace("٧", "7")
            ax.text(x_from - 110, y, f"#{step_num}",
                    ha="center", va="center", color=ACCENT,
                    fontproperties=fp_bold, fontsize=12)

    # ---- Phase bands on left ----
    phase_labels = [
        (820, 720, ar("مرحلة الكشف"),       "#3A4858"),
        (700, 580, ar("مرحلة التحليل"),      "#3A4858"),
        (460, 240, ar("مرحلة الاستجابة"),    "#3A4858"),
        (160, 110, ar("مرحلة الحل"),         "#3A4858"),
    ]
    for y_top, y_bot, label, color in phase_labels:
        ax.add_patch(Rectangle((10, y_bot - 20), 30, y_top - y_bot + 40,
                               facecolor=color, edgecolor="none", alpha=0.7))
        # Vertical text
        ax.text(25, (y_top + y_bot) / 2, label,
                ha="center", va="center", color=WHITE,
                fontproperties=fp_bold, fontsize=11, rotation=90)

    # ---- Legend (bottom-right) ----
    legend_x = 1180
    legend_y = 70
    # Telemetry arrow
    ax.add_patch(FancyArrowPatch(
        (legend_x, legend_y + 8), (legend_x + 50, legend_y + 8),
        arrowstyle="-|>", mutation_scale=12, color=MUTED, linewidth=1.8,
    ))
    ax.text(legend_x + 60, legend_y + 8,
            ar("بيانات / قياسات"),
            ha="left", va="center", color=WHITE,
            fontproperties=fp, fontsize=11)
    # Alarm arrow
    ax.add_patch(FancyArrowPatch(
        (legend_x + 230, legend_y + 8), (legend_x + 280, legend_y + 8),
        arrowstyle="-|>", mutation_scale=12, color=ACCENT, linewidth=1.8,
    ))
    ax.text(legend_x + 290, legend_y + 8,
            ar("إنذار / إشعار"),
            ha="left", va="center", color=WHITE,
            fontproperties=fp, fontsize=11)

    # ---- Footer caption ----
    ax.text(800, 30,
            ar("منظومة FGMP — دورة حياة الإنذار من الاكتشاف حتى الحل  •  شركة اليمن للموبايل"),
            ha="center", va="center", color=MUTED,
            fontproperties=fp, fontsize=10, alpha=0.85)

    plt.subplots_adjust(left=0, right=1, top=1, bottom=0)
    out_path = os.path.join(OUT_DIR, "28-dataflow-diagram.png")
    plt.savefig(out_path, dpi=100, facecolor=BG, bbox_inches="tight", pad_inches=0.1)
    plt.close(fig)
    print(f"✓ Data-flow diagram saved: {out_path}")
    return out_path


# ============================================================================
# MAIN
# ============================================================================
if __name__ == "__main__":
    arch_path = build_architecture_diagram()
    flow_path = build_dataflow_diagram()

    # Verify outputs exist and report sizes
    for p in (arch_path, flow_path):
        if os.path.exists(p):
            sz_kb = os.path.getsize(p) / 1024
            print(f"  {p}  ({sz_kb:.1f} KB)")
        else:
            print(f"  ✗ MISSING: {p}")
