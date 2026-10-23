/* eslint-disable @typescript-eslint/no-require-imports */
/**
 * FGMP Arabic Technical Proposal — RTL Word Document Generator
 *
 * Generates a comprehensive Arabic (RTL) technical proposal document for the
 * Fuel & Generator Monitoring Platform, modeled after the reference
 * "Yemen_Mobile_Fuel_Luxury_Design.pdf" but with enhanced content and structure.
 *
 * Architecture:
 *  - Cover page (R4 Top Color Block style, adapted for RTL)
 *  - Table of Contents
 *  - 13 main sections:
 *      1.  Introduction (cover letter)
 *      2.  Project Definition (6-layer architecture table + dashboard images)
 *      3.  Assumptions
 *      4.  Features (18-feature table + UI screenshots)
 *      5.  Hardware (sensors, controllers, connection options + arch diagram)
 *      6.  Software (SCDTS/SMMS/SDC/SDA/SMS/DB + UI screenshots)
 *      7.  General Advantages (table + dataflow diagram)
 *      8.  System Screenshots Gallery (12 views + region/site drill-downs)
 *      9.  Pricing & Cost Breakdown
 *      10. Implementation Timeline
 *      11. Project Team & Staffing
 *      12. Service Level Agreement (SLA)
 *      13. Testing, Acceptance & Training
 *  - All paragraphs use bidirectional: true + rightToLeft: true
 *  - All tables use visuallyRightToLeft: true
 *  - Arabic font: "Arial" (widely available, renders Arabic cleanly in MS Word + LibreOffice)
 *  - 18 embedded images (16 real screenshots + 2 generated matplotlib diagrams:
 *      28-arch-diagram.png, 28-dataflow-diagram.png)
 */

const {
  Document, Packer, Paragraph, TextRun, Header, Footer,
  AlignmentType, HeadingLevel, PageNumber, PageBreak,
  Table, TableRow, TableCell, TableLayoutType, WidthType,
  BorderStyle, ShadingType, VerticalAlign,
  TableOfContents, StyleLevel,
  NumberFormat,
  ImageRun,
} = require("docx");
const fs = require("fs");
const path = require("path");
const { imageSize } = require("image-size");

// ============================================================================
// SCREENSHOTS DIRECTORY — real captures from the running FGMP system
// ============================================================================
const SHOT_DIR = "/home/z/my-project/download/qa-28";
function loadShot(filename) {
  const p = path.join(SHOT_DIR, filename);
  if (!fs.existsSync(p)) {
    console.warn(`⚠ Screenshot not found: ${p}`);
    return null;
  }
  const buf = fs.readFileSync(p);
  const dim = imageSize(buf);
  return { buffer: buf, w: dim.width, h: dim.height };
}

// ============================================================================
// PALETTE — GO-1 Graphite Orange (proposal/bidding palette)
// ============================================================================
const P = {
  bg: "1A2330",
  primary: "FFFFFF",
  accent: "D4875A",
  titleColor: "FFFFFF",
  subtitleColor: "B0B8C0",
  metaColor: "90989F",
  footerColor: "687078",
  tableHeaderBg: "D4875A",
  tableHeaderText: "FFFFFF",
  tableAccentLine: "D4875A",
  tableInnerLine: "DDD0C8",
  tableSurface: "F8F0EB",
  bodyText: "1A2330",
  headingText: "1A2330",
  mutedText: "5A6878",
};

// ============================================================================
// BORDER HELPERS
// ============================================================================
const NB = { style: BorderStyle.NONE, size: 0, color: "FFFFFF" };
const noBorders = { top: NB, bottom: NB, left: NB, right: NB };
const allNoBorders = {
  top: NB, bottom: NB, left: NB, right: NB,
  insideHorizontal: NB, insideVertical: NB,
};

const thinBorder = (color = P.tableInnerLine) => ({
  style: BorderStyle.SINGLE, size: 4, color,
});
const tableBorders = {
  top: thinBorder(P.tableAccentLine),
  bottom: thinBorder(P.tableAccentLine),
  left: thinBorder(P.tableInnerLine),
  right: thinBorder(P.tableInnerLine),
  insideHorizontal: thinBorder(P.tableInnerLine),
  insideVertical: thinBorder(P.tableInnerLine),
};

// ============================================================================
// ARABIC FONT CONFIG
// ============================================================================
const ARABIC_FONT = { ascii: "Arial", cs: "Arial", hAnsi: "Arial" };
const ARABIC_FONT_BOLD = { ascii: "Arial", cs: "Arial", hAnsi: "Arial" };

// ============================================================================
// BUILDER HELPERS — All paragraphs are RTL (bidirectional)
// ============================================================================

function arBody(text, opts = {}) {
  return new Paragraph({
    bidirectional: true,
    alignment: AlignmentType.JUSTIFIED,
    indent: { firstLine: 480 },
    spacing: { line: 360, after: 120, ...opts.spacing },
    children: [
      new TextRun({
        text,
        size: 24,
        rightToLeft: true,
        font: ARABIC_FONT,
        color: P.bodyText,
        ...opts.run,
      }),
    ],
  });
}

function arHeading(text, level = HeadingLevel.HEADING_1, opts = {}) {
  const sizeMap = {
    [HeadingLevel.HEADING_1]: 36,
    [HeadingLevel.HEADING_2]: 30,
    [HeadingLevel.HEADING_3]: 26,
  };
  return new Paragraph({
    heading: level,
    bidirectional: true,
    alignment: AlignmentType.RIGHT,
    spacing: {
      before: level === HeadingLevel.HEADING_1 ? 480 : 360,
      after: 180,
      line: 360,
      ...opts.spacing,
    },
    children: [
      new TextRun({
        text,
        size: sizeMap[level] || 26,
        bold: true,
        rightToLeft: true,
        font: ARABIC_FONT_BOLD,
        color: P.headingText,
        ...opts.run,
      }),
    ],
  });
}

function arBullet(text, opts = {}) {
  return new Paragraph({
    bidirectional: true,
    alignment: AlignmentType.JUSTIFIED,
    indent: { right: 480, hanging: 240 },
    spacing: { line: 340, after: 80, ...opts.spacing },
    children: [
      new TextRun({
        text: "◀ ",
        size: 22,
        rightToLeft: true,
        font: ARABIC_FONT,
        color: P.accent,
        bold: true,
      }),
      new TextRun({
        text,
        size: 24,
        rightToLeft: true,
        font: ARABIC_FONT,
        color: P.bodyText,
        ...opts.run,
      }),
    ],
  });
}

function emptyPara(spacing = {}) {
  return new Paragraph({
    bidirectional: true,
    spacing: { ...spacing },
    children: [],
  });
}

function dividerLine() {
  return new Paragraph({
    bidirectional: true,
    indent: { left: 1000, right: 1000 },
    spacing: { before: 200, after: 200 },
    border: {
      bottom: { style: BorderStyle.SINGLE, size: 12, color: P.accent, space: 1 },
    },
    children: [],
  });
}

// ============================================================================
// IMAGE EMBEDDING — RTL-friendly centered image with Arabic caption
// ============================================================================
// Content width on A4 with 1.7cm L/R margins ≈ 17.6cm ≈ 666px @96dpi.
// We target a max image width of 620px to leave a small inner margin.
const MAX_IMG_W = 620;

function arImage(filename, caption, opts = {}) {
  const shot = loadShot(filename);
  if (!shot) {
    return [
      arBody(`[لم يتم العثور على الصورة: ${filename}]`, { run: { color: "AA0000" } }),
    ];
  }
  // Scale to fit content width while preserving aspect ratio
  let w = shot.w, h = shot.h;
  if (w > MAX_IMG_W) {
    const ratio = MAX_IMG_W / w;
    w = MAX_IMG_W;
    h = Math.round(h * ratio);
  }
  // Optional max height to avoid overflowing the page
  const MAX_IMG_H = opts.maxH || 520;
  if (h > MAX_IMG_H) {
    const ratio = MAX_IMG_H / h;
    h = MAX_IMG_H;
    w = Math.round(w * ratio);
  }

  const imgPara = new Paragraph({
    bidirectional: true,
    alignment: AlignmentType.CENTER,
    spacing: { before: 200, after: 80 },
    children: [new ImageRun({
      data: shot.buffer,
      transformation: { width: w, height: h },
      type: "png",
    })],
  });

  // Optional figure number label above caption
  const labelParts = [];
  if (opts.figure) labelParts.push(opts.figure);
  if (opts.label) labelParts.push(opts.label);

  const captionChildren = [];
  if (labelParts.length > 0) {
    captionChildren.push(new TextRun({
      text: labelParts.join(" — "),
      size: 20,
      bold: true,
      rightToLeft: true,
      font: ARABIC_FONT_BOLD,
      color: P.accent,
    }));
    captionChildren.push(new TextRun({
      text: "  ",
      size: 20,
      font: ARABIC_FONT,
    }));
  }
  captionChildren.push(new TextRun({
    text: caption,
    size: 20,
    italics: true,
    rightToLeft: true,
    font: ARABIC_FONT,
    color: P.mutedText,
  }));

  const captionPara = new Paragraph({
    bidirectional: true,
    alignment: AlignmentType.CENTER,
    spacing: { after: 240, line: 280 },
    children: captionChildren,
  });

  return [imgPara, captionPara];
}

// ============================================================================
// COVER PAGE — R4 Top Color Block adapted for RTL Arabic
// ============================================================================

function buildCover() {
  const padR = 1200, padL = 800;
  const UPPER_H = 9500;
  const DIVIDER_H = 80;

  const upperBlock = new Table({
    width: { size: 100, type: WidthType.PERCENTAGE },
    layout: TableLayoutType.FIXED,
    borders: allNoBorders,
    rows: [new TableRow({
      height: { value: UPPER_H, rule: "exact" },
      children: [new TableCell({
        shading: { type: ShadingType.CLEAR, fill: P.bg, color: "auto" },
        borders: noBorders,
        verticalAlign: VerticalAlign.TOP,
        margins: { left: padL, right: padR },
        children: [
          new Paragraph({ bidirectional: true, spacing: { before: 1800 }, children: [] }),
          new Paragraph({
            bidirectional: true,
            alignment: AlignmentType.RIGHT,
            spacing: { after: 600 },
            children: [new TextRun({
              text: "F G M P   T E C H N I C A L   P R O P O S A L",
              size: 18,
              color: P.accent,
              font: { ascii: "Arial", hAnsi: "Arial" },
              characterSpacing: 60,
            })],
          }),
          new Paragraph({
            bidirectional: true,
            alignment: AlignmentType.RIGHT,
            spacing: { line: 920, lineRule: "atLeast", after: 120 },
            children: [new TextRun({
              text: "عرض فني متكامل",
              size: 80,
              bold: true,
              rightToLeft: true,
              font: ARABIC_FONT_BOLD,
              color: P.titleColor,
            })],
          }),
          new Paragraph({
            bidirectional: true,
            alignment: AlignmentType.RIGHT,
            spacing: { line: 920, lineRule: "atLeast", after: 120 },
            children: [new TextRun({
              text: "لمنظومة مراقبة وإدارة الوقود",
              size: 80,
              bold: true,
              rightToLeft: true,
              font: ARABIC_FONT_BOLD,
              color: P.titleColor,
            })],
          }),
          new Paragraph({
            bidirectional: true,
            alignment: AlignmentType.RIGHT,
            spacing: { line: 920, lineRule: "atLeast", after: 300 },
            children: [new TextRun({
              text: "والتحكم بالمولّدات",
              size: 80,
              bold: true,
              rightToLeft: true,
              font: ARABIC_FONT_BOLD,
              color: P.titleColor,
            })],
          }),
          new Paragraph({
            bidirectional: true,
            alignment: AlignmentType.RIGHT,
            spacing: { after: 200 },
            children: [new TextRun({
              text: "حلول تقنية متكاملة لمراقبة مخزون الوقود والمولّدات",
              size: 26,
              rightToLeft: true,
              font: ARABIC_FONT,
              color: P.subtitleColor,
            })],
          }),
          new Paragraph({
            bidirectional: true,
            alignment: AlignmentType.RIGHT,
            spacing: { after: 100 },
            children: [new TextRun({
              text: "ضمن شبكة المواقع المنتشرة في الجمهورية اليمنية",
              size: 26,
              rightToLeft: true,
              font: ARABIC_FONT,
              color: P.subtitleColor,
            })],
          }),
        ],
      })],
    })],
  });

  const divider = new Table({
    width: { size: 100, type: WidthType.PERCENTAGE },
    borders: allNoBorders,
    rows: [new TableRow({
      height: { value: DIVIDER_H, rule: "exact" },
      children: [new TableCell({
        borders: noBorders,
        shading: { type: ShadingType.CLEAR, fill: P.accent, color: "auto" },
        children: [emptyPara()],
      })],
    })],
  });

  const metaLines = [
    "نوع العرض: عرض فني وتقني متكامل",
    "جهة الإعداد: الشركة اليمنية للموبايل",
    "الجهة المستفيدة: إدارة الوقود والمولّدات",
    "سنة الإصدار: 2026 م",
    "الإصدار: النسخة الفاخرة المعزّزة",
  ];

  const lowerContent = [
    new Paragraph({ bidirectional: true, spacing: { before: 800 }, children: [] }),
    ...metaLines.map((line) => new Paragraph({
      bidirectional: true,
      alignment: AlignmentType.RIGHT,
      indent: { right: padR },
      spacing: { after: 140 },
      children: [new TextRun({
        text: line,
        size: 26,
        rightToLeft: true,
        font: ARABIC_FONT,
        color: P.metaColor,
      })],
    })),
    new Paragraph({ bidirectional: true, spacing: { before: 2400 }, children: [] }),
    new Paragraph({
      bidirectional: true,
      alignment: AlignmentType.RIGHT,
      indent: { right: padR },
      children: [
        new TextRun({
          text: "سري 1 — مراقبة وإدارة الوقود",
          size: 20,
          rightToLeft: true,
          font: ARABIC_FONT,
          color: P.footerColor,
        }),
      ],
    }),
  ];

  return [new Table({
    width: { size: 100, type: WidthType.PERCENTAGE },
    layout: TableLayoutType.FIXED,
    borders: allNoBorders,
    rows: [new TableRow({
      height: { value: 16838, rule: "exact" },
      children: [new TableCell({
        shading: { type: ShadingType.CLEAR, fill: "FFFFFF", color: "auto" },
        borders: noBorders,
        verticalAlign: VerticalAlign.TOP,
        children: [
          upperBlock,
          divider,
          ...lowerContent,
        ],
      })],
    })],
  })];
}

// ============================================================================
// TABLE OF CONTENTS
// ============================================================================

function buildTOC() {
  return [
    new Paragraph({
      bidirectional: true,
      alignment: AlignmentType.CENTER,
      spacing: { before: 600, after: 400 },
      children: [new TextRun({
        text: "جدول المحتويات",
        size: 44,
        bold: true,
        rightToLeft: true,
        font: ARABIC_FONT_BOLD,
        color: P.headingText,
      })],
    }),
    new Paragraph({
      bidirectional: true,
      indent: { left: 200, right: 200 },
      spacing: { after: 400 },
      border: { bottom: { style: BorderStyle.SINGLE, size: 12, color: P.accent, space: 4 } },
      children: [],
    }),
    new TableOfContents("جدول المحتويات", {
      hyperlink: true,
      headingStyleRange: "1-3",
      stylesWithLevels: [
        new StyleLevel("Heading1", 1),
        new StyleLevel("Heading2", 2),
        new StyleLevel("Heading3", 3),
      ],
    }),
    new Paragraph({
      bidirectional: true,
      children: [new PageBreak()],
    }),
  ];
}

// ============================================================================
// TABLE BUILDER — RTL tables
// ============================================================================

function arTable(headers, rows) {
  const colCount = headers.length;
  const colWidth = Math.floor(100 / colCount);

  const headerRow = new TableRow({
    tableHeader: true,
    cantSplit: true,
    children: headers.map((h) => new TableCell({
      width: { size: colWidth, type: WidthType.PERCENTAGE },
      shading: { type: ShadingType.CLEAR, fill: P.tableHeaderBg, color: "auto" },
      margins: { top: 100, bottom: 100, left: 120, right: 120 },
      verticalAlign: VerticalAlign.CENTER,
      children: [new Paragraph({
        bidirectional: true,
        alignment: AlignmentType.CENTER,
        children: [new TextRun({
          text: h,
          size: 22,
          bold: true,
          rightToLeft: true,
          font: ARABIC_FONT_BOLD,
          color: P.tableHeaderText,
        })],
      })],
    })),
  });

  const dataRows = rows.map((row, idx) => new TableRow({
    cantSplit: true,
    children: row.map((cell) => new TableCell({
      width: { size: colWidth, type: WidthType.PERCENTAGE },
      shading: idx % 2 === 1
        ? { type: ShadingType.CLEAR, fill: P.tableSurface, color: "auto" }
        : undefined,
      margins: { top: 80, bottom: 80, left: 120, right: 120 },
      verticalAlign: VerticalAlign.CENTER,
      children: [new Paragraph({
        bidirectional: true,
        alignment: AlignmentType.RIGHT,
        children: [new TextRun({
          text: String(cell),
          size: 22,
          rightToLeft: true,
          font: ARABIC_FONT,
          color: P.bodyText,
        })],
      })],
    })),
  }));

  return new Table({
    width: { size: 100, type: WidthType.PERCENTAGE },
    layout: TableLayoutType.FIXED,
    borders: tableBorders,
    rows: [headerRow, ...dataRows],
    visuallyRightToLeft: true,
  });
}

// ============================================================================
// CONTENT — Sections 1-7
// ============================================================================

function buildSection1_Introduction() {
  return [
    arHeading("القسم الأول: مقدمة العرض", HeadingLevel.HEADING_1),
    dividerLine(),

    arHeading("خطاب التقديم", HeadingLevel.HEADING_2),
    arBody("الشركة اليمنية للموبايل / الإخوة الكرام، تحية طيبة وبعد،"),
    arBody(
      "يسعدنا أن نقدّم لسيادتكم هذا العرض الفني المتكامل لمنظومة مراقبة وإدارة مخزون الوقود والتحكم بالمولّدات، وذلك إشارةً إلى الموضوع المشار إليه أعلاه. وعندما نتصدّى لتقديم هذه المنظومة، فإننا نضع بين أيديكم منظومة ذكية متكاملة لمراقبة وإدارة مخزون الوقود والتحكم بالمولّدات، تتميّز بالمزايا التالية:"
    ),
    arBullet("مراقبة كميات الوقود والمولّدات بشكل لحظي ودقيق عن بُعد دون انقطاع."),
    arBullet("الاطلاع على مخزون الوقود ضمن نطاق مواقع الشركة المنتشرة في الجمهورية اليمنية."),
    arBullet("رصد وتسجيل كميات السلاقة أو التسريب غير المشروع عند وقود المولّدات."),
    arBullet("مراقبة الكميات الفعلية للوقود بضغط لحظي ودقيق من مصدر واحد."),
    arBullet("مطابقة الكميات للمواقع والخزانات مع أوامر التوريد."),
    arBullet("التنبيه الآلي عند الأحداث غير الاعتيادية في الموقع."),
    arBullet("التنبيه الآلي عند انخفاض الكميات لنسبة معينة."),

    arHeading("أهمية القياس الإلكتروني للخزانات", HeadingLevel.HEADING_2),
    arBody(
      "كان الاهتمام دائماً منصبّاً على معرفة الكميات الحقيقية والموثوقة للوقود الموجود في الخزانات، وذلك مهما كانت المسافات أو الصعوبات التي تواجه الوصول إليها. وتُعدّ منظومة القياس الإلكتروني للخزانات من أهم ما تقدّمه التقنية الحديثة، حيث تُعطي القياسات الحقيقية والصحيحة للكميات حتى لو كانت الخزانات في مواقع نائية أو بعيدة عن مركز التحكم."
    ),
    arBody(
      "كما تُتيح هذه المنظومة إمكانية الحفاظ على المواقع والمحطات والمولّدات العاملة دون انقطاع، وذلك من خلال:"
    ),
    arBullet("التحكم بالمولّدات الآلية وتشغيلها عند الحاجة."),
    arBullet("القدرة على تشغيل المولّدات عن بُعد للحالات الطارئة."),
    arBullet("مراقبة البطاريات ومستوى شحنها وتشغيل المولّدات الآلية عند انخفاض مستوى البطاريات."),

    arHeading("استدامة التشغيل واستخدام البيانات للقرارات التحليلية", HeadingLevel.HEADING_2),
    arBody(
      "ستتمكّن الشركة من تنفيذ خطط تشغيلية على المدى القريب والبعيد، وكذلك تخطيط التوزيع، وذلك انطلاقاً من البيانات الأساسية للمنظومة. كما تُتيح المنظومة معرفة الاستهلاك العام للوقود بأدق تفاصيله ضمن منظومة مغلقة، ومطابقة خطط التوريد ومتابعتها، وصولاً إلى الثقة والتأكيد على وصول الكميات للمواقع المحددة."
    ),
    arBody(
      "نأمل أن ينال هذا العرض رضاكم وتقديركم، ونحن على أتم الاستعداد لتقديم المزيد من التفاصيل والإيضاحات عند الحاجة.",
      { run: { bold: true } }
    ),
    arBody("والسلام عليكم ورحمة الله وبركاته.", { run: { bold: true } }),
    arBody("مقدّم العرض الفني / المهندس", { run: { italics: true } }),
    arBody("إدارة ومراقبة مخزون الوقود والمولّدات والبطاريات", { run: { italics: true } }),

    new Paragraph({ bidirectional: true, children: [new PageBreak()] }),
  ];
}

function buildSection2_ProjectDefinition() {
  return [
    arHeading("القسم الثاني: تعريف المشروع ونطاق العمل", HeadingLevel.HEADING_1),
    dividerLine(),

    arBody(
      "تعتمد هذه المنظومة على حساسات دقيقة عالية الجودة يتم تركيبها في المواقع لقياس مستويات الوقود في الخزانات ذات السعة العالية، وترتبط مباشرةً بخدمة جمع البيانات عبر طرق معالجة ودوائر إلكترونية عالية التقنية، ليتم ربط جميع هذه المواقع بالنظام الرئيسي بكفاءة عالية. تقوم خدمة جمع البيانات باستقبال البيانات من هذه الحساسات بشكل مستمر، ومعالجتها، وإصدار الإنذارات، كما يمكن للنظام إجراء تحليلات أعمق للبيانات عبر تنفيذ الإجراءات المطلوبة في كل حالة، وذلك من خلال إخراج تقارير دورية خلال فترات زمنية معينة تعطي صورة شاملة لما يتم تشغيله من عمليات، تشمل:"
    ),
    arBullet("تكاليف التشغيل ومستويات الاستهلاك للوقود."),
    arBullet("الإنذارات بنسبة النقصان غير المشروع للوقود."),
    arBullet("متابعة أوامر التوريد بالكميات للمواقع."),
    arBullet("تغيير الزيت والفلاتر للمولّدات التي تحتاج صيانة دورية."),
    arBullet("الإحصائيات والبيانات التي تساعد على اتخاذ القرارات المناسبة."),

    arBody(
      "الفائدة الاستراتيجية: تساعد هذه المزايا في تحقيق أفضل عائد للشركة عبر تقليل المبالغ المهدرة، وذلك من خلال المثال الأمثل للموارد والوقود وتشغيل المولّدات.",
      { run: { bold: true, color: P.accent } }
    ),

    arHeading("الشكل (1): الهيكل العام للمنظومة", HeadingLevel.HEADING_3),
    arBody("يتكوّن الهيكل العام للمنظومة من الطبقات التالية:", { run: { bold: true } }),

    arTable(
      ["الطبقة", "المكّون", "الوصف"],
      [
        ["1", "حساسات الموقع", "حساسات قياس مستوى الوقود + دوائر التحكم والقياس"],
        ["2", "بوابة الموقع", "جهاز تجميع البيانات مع اتصال شبكي/SMS"],
        ["3", "الشبكة", "ربط لاسلكي 3G/4G/SMS مختلط حسب التغطية"],
        ["4", "الخادم المركزي", "خدمات SCDTS, SMMS, SDC, SDA, SMS"],
        ["5", "قاعدة البيانات", "قاعدة بيانات حديثة آمنة مع نسخ احتياطي يومي"],
        ["6", "واجهة المستخدم", "لوحة ويب + تطبيق جوال + تنبيهات SMS/بريد"],
      ]
    ),

    arBody(
      "وفيما يلي لقطة حقيقية من لوحة مركز العمليات في المنظومة، تعرض المؤشرات الرئيسية والمخططات والخرائط بشكل لحظي:"
    ),

    ...arImage(
      "28-01-view-ar.png",
      "لوحة مركز العمليات — نظرة لحظية شاملة على المواقع والوقود والمولّدات والإنذارات، مع مؤشر الصحة الوطني والخريطة التفاعلية وتدفّق الأحداث المباشر.",
      { figure: "الشكل (1-أ)", label: "لوحة مركز العمليات" }
    ),

    ...arImage(
      "28-13-region-sheet-ar.png",
      "نافذة تفاصيل المنطقة — عرض تفصيلي لمنطقة المرتفعات الشمالية يشمل المؤشرات والرسوم البيانية وقائمة المواقع والإنذارات المرتبطة بالمنطقة.",
      { figure: "الشكل (1-ب)", label: "تفاصيل المنطقة" }
    ),

    new Paragraph({ bidirectional: true, children: [new PageBreak()] }),
  ];
}

function buildSection3_Assumptions() {
  return [
    arHeading("القسم الثالث: الافتراضات التي بُني عليها العرض", HeadingLevel.HEADING_1),
    dividerLine(),

    arBody(
      "بُني هذا العرض التقني على الافتراضات الأساسية التالية والتي تضمن نجاح تطبيق المنظومة وتشغيلها بكفاءة عالية في جميع مواقع الشركة:"
    ),

    arHeading("(1) إمكانية التشغيل الكهربائي للمولّدات", HeadingLevel.HEADING_3),
    arBody(
      "جميع المولّدات الكهربائية في المواقع تعمل بمفاتيح تشغيل يمكن من خلالها إيقافها وتشغيلها، بمعنى أنّ إيقافها وتشغيلها لا يتم يدوياً أو ديازياً."
    ),

    arHeading("(2) توفّر مصدر التغذية الكهربائية", HeadingLevel.HEADING_3),
    arBody(
      "تتولّى الشركة توفير مصدر تغذية كهربائي لأجهزة الحساسات والتحكم في جميع المواقع، بحيث يتم ربطها بالمواقع."
    ),

    new Paragraph({ bidirectional: true, children: [new PageBreak()] }),
  ];
}

function buildSection4_Features() {
  return [
    arHeading("القسم الرابع: خصائص ومزايا المنظومة", HeadingLevel.HEADING_1),
    dividerLine(),

    arBody(
      "توفّر المنظومة الذكية لمراقبة وإدارة مخزون الوقود مجموعة شاملة من الخصائص والمزايا التي تلبّي احتياجات شركة اليمن للموبايل، وفيما يلي أبرز تفصيل لهذه المزايا:"
    ),

    arHeading("الشكل (2): المزايا الرئيسية", HeadingLevel.HEADING_3),

    arTable(
      ["#", "الميزة", "الوصف"],
      [
        ["1", "مراقبة لحظية", "مراقبة لحظية لمستويات الوقود المخزون في المواقع المختلفة على مستوى الجمهورية"],
        ["2", "حالة المولّدات", "إمكانية مراقبة لحظية لحالة المولّدات الكهربائية في كل موقع"],
        ["3", "مطابقة التوريد", "متابعة كميات الوقود المورّدة للمواقع مع سجلات التوريد"],
        ["4", "تنبيهات إعادة التعبئة", "استقبال تنبيهات من المواقع عند وصول كميات الوقود المخزون لمستويات طلب إعادة التعبئة"],
        ["5", "تنبيهات الحرج", "استقبال تنبيهات عند اقتراب نفاد الوقود المخزون لنقاط الحرجة"],
        ["6", "منع النفاد الكامل", "استقبال تنبيهات لمنع إنفاد الوقود المخزون وتوقف المولّدات بشكل كامل"],
        ["7", "كشف الشذوذ", "استقبال إنذارات وتنبيهات عند حدوث هبوط غير اعتيادي أو غير طبيعي في مستويات الوقود"],
        ["8", "مراقبة مزدوجة", "القدرة على مراقبة الوقود على الخزانات في نفس الوقت"],
        ["9", "تشغيل متبادل", "القدرة على التحكم بالمولّدتين في نفس الوقت، وضبط التشغيل الآلي لهما"],
        ["10", "تنبيهات الانقطاع", "استقبال تنبيهات لمنع انقطاع أو فصل أي جزء من أجزاء المنظومة الرئيسية"],
        ["11", "تنبيهات الصيانة", "استقبال تنبيهات بتجاوز المولّدات للمعدّل المحدد للعمل"],
        ["12", "صيانة دورية", "استقبال تنبيهات بالصيانة الدورية للمولّدات من تغيير الزيت أو الفلاتر"],
        ["13", "جدولة تشغيل", "إمكانية تشغيل وإيقاف المولّدات الكهربائية بطرق مختلفة كالجدولة الزمنية"],
        ["14", "تحكم مركزي", "إمكانية تشغيل وإيقاف المولّدات الكهربائية عن بُعد بشكل مركزي من النظام"],
        ["15", "تنبيه فشل التشغيل", "إرسال رسالة تنبيه إلى فريق الصيانة عند فشل تشغيل المولّد"],
        ["16", "قياس داخل الخزان", "القدرة على قياس كميات الوقود داخل الخزانات عبر إدخال نقاط المعايرة"],
        ["17", "تقارير تحليلية", "توفير تقارير تحليلية نوعية لمقارنة معدّلات الاستهلاك خلال فترات زمنية مختلفة"],
        ["18", "تتبّع الأحداث", "توفير تقارير تحليلية لتتبّع سجل الأحداث للموقع لأي فترة زمنية"],
      ]
    ),

    arBody(
      "وتُجسّد اللقطات الحقيقية التالية من المنظومة بعضاً من هذه المزايا أثناء التشغيل الفعلي:"
    ),

    ...arImage(
      "28-06-view-ar.png",
      "إدارة الإنذارات — عرض جميع الإنذارات النشطة مع تصنيفها حسب المستوى (حرج/تحذير/معلومة) وحالتها، مع إمكانية التصفية والتصدير وتفعيل قواعد الارتباط بين الأحداث.",
      { figure: "الشكل (2-أ)", label: "إدارة الإنذارات" }
    ),

    ...arImage(
      "28-03-view-ar.png",
      "مراقبة الوقود — عرض شامل لمخزون الوقود في جميع المواقع مع رسوم بيانية لنسب الامتلاء والتنبيهات اللحظية للخزانات الحرجة ومنخفضة المخزون.",
      { figure: "الشكل (2-ب)", label: "مراقبة الوقود" }
    ),

    ...arImage(
      "28-04-view-ar.png",
      "إدارة المولّدات — عرض حالة جميع المولّدات الكهربائية مع ساعات التشغيل وحالة التشغيل/الإيقاف والإنذارات المرتبطة، مع لوحة تنبّؤ بالصيانة الدورية.",
      { figure: "الشكل (2-ج)", label: "إدارة المولّدات" }
    ),

    new Paragraph({ bidirectional: true, children: [new PageBreak()] }),
  ];
}

function buildSection5_Hardware() {
  return [
    arHeading("القسم الخامس: المكوّنات والخيارات التقنية (Hardware)", HeadingLevel.HEADING_1),
    dividerLine(),

    arBody(
      "توفّر الشركة مجموعة من الخيارات للأجهزة التي يمكن استخدامها في منظومة مراقبة وإدارة مخزون الوقود، وتختلف في تطبيقاتها الفنية والتقنية، وتتحدّت جميعها عند مستوى عالٍ من الجودة والأداء ملاءم الظروف التشغيلية، مع ضمان متاع وكفالة شاملة لأجزاء المنظومة."
    ),

    arHeading("أولاً: حساسات قياس مستوى الوقود (Fuel Level Sensors)", HeadingLevel.HEADING_2),
    arBody(
      "تتوفر أنواع عديدة من الحساسات الخاصة بقياس مستويات السوائل في الخزانات، وتختلف في مستوى الجودة والسعر وشروط العمل، وتنتشر على نطاق واسع في الأسواق. وميزة الحساسات التي تقدّمها الشركة هي التقنية المستخدمة والمتانة والعمر الافتراضي، ممّا يجعلها قادرة على العمل في ظروف المواقع المختلفة."
    ),

    arTable(
      ["المعيار", "المواصفة", "ملاحظات"],
      [
        ["نوع التقنية", "موجات فوق صوتية / مقاومة متغيرة", "حسب نوع الخزان والبيئة"],
        ["مدى القياس", "حتى 5 أمتار", "قابل للتخصيص"],
        ["الدقة", "± 0.5% من مدى القياس", "مناسبة للخزانات كبيرة السعة"],
        ["مقاومة البيئة", "IP67 / IP68", "محمي ضد الغبار والرطوبة"],
        ["درجة الحرارة", "-20°C إلى +70°C", "ملائم للظروف اليمنية"],
        ["التغذية الكهربائية", "9-36 VDC", "متوافق مع أنظمة الطاقة في المواقع"],
        ["المخرج", "4-20 mA / RS485 / Modbus", "حسب نوع الربط"],
      ]
    ),

    arHeading("ثانياً: أجهزة التحكم ونقل البيانات (Controllers)", HeadingLevel.HEADING_2),
    arBody(
      "تعتبر هذه الأجهزة عبارة عن دوائر إلكترونية عالية التقنية، يتم تركيبها في كل موقع، وتتولّى عملية نقل البيانات وتنفيذ الأوامر بين الموقع والنظام. ترتبط مع عدد من الحساسات وأجهزة القياس في الموقع، ويتم برمجتها لتنفيذ جميع العمليات المنطقية لها بحسب الوظيفة. كما ترتبط أجهزة قياس مستوى الوقود مع حساسات توفير المراقبة الآلية للخزان، ومع أجهزة التحكم بالمولّدات لتوفير المراقبة الآلية للمولّدات الكهربائية عن بُعد."
    ),
    arBody("تقوم هذه الأجهزة بوظيفة نقل البيانات إلى النظام الرئيسي واستقبال الأوامر الصادرة منه، وذلك باستخدام أحد خيارات الربط الإلكتروني كما يلي:"),

    arHeading("خيارات الربط الإلكتروني", HeadingLevel.HEADING_3),
    arTable(
      ["نوع الربط", "الاستخدام", "المزايا"],
      [
        ["شبكة بيانات (3G/4G)", "المواقع التي تتوفّر فيها شبكة بيانات", "سرعة نقل عالية، زمن استجابة منخفض"],
        ["رسائل قصيرة (SMS)", "المواقع المنفردة دون شبكة بيانات", "تغطية أوسع، اعتمادية عالية في المناطق النائية"],
        ["ربط مختلط", "ضمان استمرارية النقل في جميع الظروف", "جمع بين الشبكة والرسائل القصيرة"],
      ]
    ),

    arHeading("ثالثاً: أجهزة التحكم والقياس للمولّدات", HeadingLevel.HEADING_2),
    arBody(
      "هذه الأجهزة تعتبر عبارة عن دوائر إلكترونية يتم تركيبها على المولّدات، وتتولّى عملية معرفة حالة تشغيل المولّدات الكهربائية وتنفيذ أوامر الإيقاف والتشغيل. ترتبط مباشرةً مع أجهزة التحكم ونقل البيانات، وتعمل مع المنظومة بشكل متكامل."
    ),

    arHeading("الشكل (3): الهيكل العام للمنظومة — مخطط الطبقات الست", HeadingLevel.HEADING_3),
    arBody(
      "يُوضّح المخطط التالي الهيكل العام للمنظومة بطبقاتها الست وتدفّق البيانات والتحكّم بين الطبقات، بدءاً من الحساسات في المواقع، مروراً ببوابة الموقع وشبكة النقل، وصولاً إلى الخادم المركزي وقاعدة البيانات وانتهاءً بواجهات المستخدم النهائية."
    ),
    ...arImage(
      "28-arch-diagram.png",
      "مخطط الطبقات الست وتدفّق البيانات — يوضّح تدفّق القياسات صعوداً من الحساسات إلى واجهة المستخدم، وتدفّق أوامر التحكم نزولاً من المشغّل إلى أجهزة الموقع.",
      { figure: "الشكل (3)", label: "الهيكل العام للمنظومة" }
    ),

    new Paragraph({ bidirectional: true, children: [new PageBreak()] }),
  ];
}

function buildSection6_Software() {
  return [
    arHeading("القسم السادس: البرامج والخدمات (Software)", HeadingLevel.HEADING_1),
    dividerLine(),

    arBody(
      "تتألّف المنظومة الذكية من مجموعة من البرامج والتطبيقات التي أُعدّت خصيصاً لإدارة المواقع عن بُعد، وتتكامل مع بعضها البعض لتلبية جميع المتطلبات وأداء عالٍ، كما توفّر للمستخدم جميع البيانات التي يحتاجها وتتخذ القرارات في كيفية أداء عمله على أفضل وجه."
    ),

    arHeading("الشكل (4): مكوّنات البرامج والخدمات المتكاملة", HeadingLevel.HEADING_3),

    arTable(
      ["الرمز", "اسم النظام", "الوصف"],
      [
        ["SCDTS", "نظام التحكم بالحساسات", "إدارة عمل أجهزة التحكم المرتبطة بالحساسات"],
        ["SMMS", "نظام مراقبة وإدارة مخزون الوقود", "واجهة العمل الرئيسية للمستخدم"],
        ["SDC", "خدمة تجميع البيانات", "تجميع البيانات من المواقع ومعالجتها"],
        ["SDA", "خدمة تحليل البيانات", "تحليل البيانات وإصدار الإنذارات والإحصائيات"],
        ["SMS", "خدمة إرسال الرسائل القصيرة", "إرسال الإنذارات للأشخاص المعنيين"],
        ["DB", "قاعدة بيانات المنظومة", "تخزين جميع البيانات والأحداث"],
      ]
    ),

    arHeading("١. نظام التحكم بالحساسات (SCDTS)", HeadingLevel.HEADING_2),
    arBody(
      "يقوم هذا الجزء من النظام بإدارة عمل أجهزة التحكم المرتبطة بالحساسات، والتي تقوم باستقبال البيانات من الحساسات وتحتفظ بها في ملف الأحداث، كما يقوم هذا الجهاز باستقبال البيانات وإرسالها إلى النظام الرئيسي باستخدام عدد من الطرق الإلكترونية. كما يقوم هذا النظام باستقبال الطلبات والأوامر من النظام الرئيسي وإرسالها إلى دوائر التحكم بالحساسات والمولّدات."
    ),
    arBody(
      "يعمل النظام على تعديل وحفظ البيانات والإعدادات الخاصة بعمل المنظومة، كما يمكن ربطه بالنظام المستقبلي لإرسالها، ويمكن تعديل الإعدادات الخاصة بالشبكة وأجهزة القياس وبرمجتها من النظام الرئيسي عن بُعد."
    ),

    arHeading("٢. نظام مراقبة وإدارة مخزون الوقود (SMMS)", HeadingLevel.HEADING_2),
    arBody(
      "يمثّل هذا الجزء النظام الذي يتعامل معه المستخدم مباشرةً عن طريق واجهات العمل الرئيسية، ويتم تركيبه على خوادم الشركة في المركز الرئيسي. يوفّر النظام المزايا التالية:"
    ),
    arBullet("عرض ومتابعة البيانات الحالية لجميع المواقع (مستوى الوقود، حالة المولّدات، الكميات الموردة - آخر عملية توريد) عبر واجهات عرض رسمية سهلة في التفاعل والفهم."),
    arBullet("عرض البيانات التاريخية لكل موقع خلال فترات زمنية مختلفة باستخدام رسوم بيانية جذابة وسهلة."),
    arBullet("استخراج الإنذارات وحساب التقارير المتعلقة بأعمال المراقبة بشكل سلس ومرن."),
    arBullet("توفير تقارير شاملة وتفصيلية تلبّي جميع المتطلبات."),
    arBullet("تعريف وتفعيل المواقع الجديدة وربطها بالمنظومة وتحديث برمجيات أجهزة القياس."),
    arBullet("تحديد مناطق العمل (المناطق) وتعيين الأخصائيين لكل منطقة لتحديد مصدر الإنذارات الآلي."),
    arBullet("إدارة عملية إنشاء المستخدمين ومجموعات العمل وربطها بالمناطق الجغرافية مع تحديد الصلاحيات."),
    arBullet("إرسال أوامر التحكم المطلوبة لأجهزة التحكم في المواقع مع استنساخها بصرياً (إعادة ضبط أجهزة التحكم والقياس، تشغيل/إيقاف المولّدات الكهربائية عن بُعد)."),
    arBullet("إدارة الإنذارات والرسائل الطارئة وتعيين الأخصائيين المسؤولين عن الصيانة."),

    ...arImage(
      "28-02-view-ar.png",
      "إدارة المواقع — واجهة SMMS لعرض جميع المواقع مع تفاصيل كل موقع (المعرف، الاسم، المنطقة، الحالة، مستوى الوقود، حالة المولّد) وإمكانية البحث والتصفية والوصول لتفاصيل كل موقع.",
      { figure: "الشكل (4-أ)", label: "إدارة المواقع (SMMS)" }
    ),

    ...arImage(
      "28-14-site-detail-ar.png",
      "نافذة تفاصيل الموقع — عرض شامل لبيانات موقع واحد يشمل الخزانات والمولّدات والبطاريات والإنذارات النشطة والملاحظات التشغيلية، مع إمكانية إصدار أوامر التحكم عن بُعد.",
      { figure: "الشكل (4-ب)", label: "تفاصيل الموقع" }
    ),

    arHeading("٣. خدمة تجميع البيانات (SDC)", HeadingLevel.HEADING_2),
    arBody(
      "هذه الخدمة عبارة عن برنامج يعمل في الخلفية بشكل خاص على خوادم المنظومة، يقوم بعملية تجميع البيانات التي يتم إرسالها من أجهزة التحكم بالحساسات والمولّدات في جميع المواقع، كما يقوم بمعالجتها وحفظها مباشرةً في قاعدة بيانات المنظومة لاستخدامها في تحليلها لاحقاً. كذلك تتولّى هذه الخدمة:"
    ),
    arBullet("التأكد من تسلسل البيانات الواردة من المواقع وعدم وجود بيانات ناقصة أو أجزاء مفقودة."),
    arBullet("تولّي عملية إرسال رسائل الإنذارات لمنع انقطاع الاتصال بالمنظومة بسبب خلل في شبكة الاتصال."),
    arBullet("تولّي عملية حفظ جميع الأحداث التشغيلية داخل سجل الأحداث اليومي لأغراض المتابعة وحل المشاكل."),

    arHeading("٤. خدمة تحليل وتقييم البيانات (SDA)", HeadingLevel.HEADING_2),
    arBody(
      "يمثّل هذا الجزء قلب النظام البانّ، الذي يؤدي إلى إجراء عمليات التحليل والتحقق من البيانات التي تحتاج إلى إصدار إنذارات أو تنبيهات، يقوم بتحديدها بدقّة، كما يقوم بتقييم أهمية هذه التنبيهات بمستوى ينبّه لها. تبرز أهمية هذه الخدمة في النقاط التالية:"
    ),
    arBullet("تدقيق وفحص جميع البيانات المحفوظة والمراقبة بدقة لتحديد أي مؤشرات تحتاج لإصدار تنبيهات أو إنذارات."),
    arBullet("التحكّم بنوعية التواصل بين النظام والمواقع سواء عبر الرسائل القصيرة أو البريد الإلكتروني أو العرض المباشر واللحظي."),
    arBullet("توفير أرشيف كامل للمواقع يمكن للمستخدم من استخراج التقارير المطلوبة واتخاذ القرارات المناسبة."),
    arBullet("الحفظ اليومي والدوري للبيانات على قاعدة البيانات مع نسخ احتياطية."),

    arHeading("٥. خدمة إرسال الرسائل القصيرة (SMS)", HeadingLevel.HEADING_2),
    arBody(
      "هذه الخدمة عبارة عن برنامج يعمل في الخلفية على نظام التشغيل الخاص بالمنظومة، ويقوم بعملية إرسال رسائل الإنذارات، وتحويل هذه الأحداث إلى وسائط تواصلية إلى الأخصائيين المسؤولين عن معالجة هذه الأحداث التي تم تحديدها مسبقاً قبل تشغيل المنظومة وتصنيبها."
    ),
    arBullet("هذه الخدمة مبنية على بروتوكولات اتصال خاصة بخدمات الرسائل القصيرة والربط مع مركز الرسائل (SMPP)."),
    arBullet("تقوم بإرسال جميع الرسائل الناتجة عن تقييم وتحليل البيانات من المواقع إلى وسائط التواصل للأشخاص المعنيين."),
    arBullet("تقوم بحفظ جميع الأحداث التشغيلية داخل سجل الأحداث اليومي لأغراض المتابعة وحل المشاكل."),
    arBullet("تتطلّب هذه الخدمة توفير ربط إلكتروني مع مركز الرسائل القصيرة وتحديد رقم خاص بالخدمة."),

    arHeading("٦. قاعدة بيانات المنظومة", HeadingLevel.HEADING_2),
    arBody(
      "بُنيت المنظومة على قاعدة بيانات حديثة وآمنة مع تخزين يضمن حفظ جميع البيانات والأحداث الخاصة بالمنظومة، وتوفّر مستوى عالٍ من السرعة والأمان في التعامل مع هذه البيانات. كما تم في عملية تصميم هياكل البيانات المختلفة اهتمام بالغ بأكبر قدر من التكامل والتجنّب من التكرار بين الجداول وبين العلاقات الرقمية."
    ),
    arBody(
      "تم بناء قاعدة البيانات على خوادم المنظومة مع إعداد عمليات النسخ الاحتياطي الآلي اليومي، ممّا يضمن الحفاظ على البيانات وتوفير النظام بشكل مستمر على مدار 24 ساعة."
    ),

    new Paragraph({ bidirectional: true, children: [new PageBreak()] }),
  ];
}

function buildSection7_GeneralAdvantages() {
  return [
    arHeading("القسم السابع: المزايا العامة للعرض", HeadingLevel.HEADING_1),
    dividerLine(),

    arBody(
      "يتميّز هذا العرض التقني بمجموعة من المزايا العامة التي تجعله خياراً مثالياً لشركة اليمن للموبايل، وتضمن استمرارية التشغيل والجودة على المدى الطويل للخدمات المقدّمة:"
    ),

    arHeading("الشكل (6): إحصائيات المنظومة والمزايا", HeadingLevel.HEADING_3),

    arTable(
      ["الميزة", "الوصف", "القيمة"],
      [
        ["الضمان الشامل", "ضمان شامل لجميع الأجهزة مع توفير قطع غيار لمدة عشر سنوات", "10 سنوات"],
        ["الدعم الفني المستمر", "توفير فريق دعم فني على مدار الساعة لمدة 24 ساعة", "24/7"],
        ["المرونة في التشغيل", "إمكانية ربط النظام بأي موقع من المواقع بغضّ النظر عن حدوده", "غير محدود"],
        ["التقارير التحليلية", "توفير تقارير نوعية يمكن من خلالها مقارنة معدّلات الاستهلاك", "مدمجة"],
        ["الأمان والموثوقية", "قاعدة بيانات آمنة حديثة مع نسخ احتياطي يومي", "يومي"],
        ["الواجهة ثنائية اللغة", "دعم كامل للغتين العربية والإنجليزية مع تبديل فوري RTL/LTR", "EN/AR"],
        ["التحكم بالوصول (RBAC)", "نظام صلاحيات قائم على الأدوار مع 6 أدوار", "6 أدوار"],
        ["المراقبة اللحظية", "تحديث البيانات كل 5 ثوانٍ مع بث مباشر للأحداث والإنذارات", "5 ثوانٍ"],
        ["التنبيهات المتعددة", "تنبيهات فورية عبر البريد الإلكتروني والرسائل القصيرة ولوحة الويب", "3 قنوات"],
      ]
    ),

    arHeading("الشكل (5): مخطط تدفّق البيانات", HeadingLevel.HEADING_3),
    arBody(
      "يُبيّن المخطط التالي دورة حياة الإنذار في المنظومة، بدءاً من اكتشاف الحدث غير الاعتيادي في الموقع، مروراً بتحليل البيانات وإصدار الإشعارات، وصولاً إلى استجابة المشغّل وحلّ الإنذار وتأكيد الحل."
    ),
    ...arImage(
      "28-dataflow-diagram.png",
      "مخطط تدفّق البيانات — من اكتشاف الإنذار حتى الاستجابة والحل، عبر خمسة أطراف متعاونة: الموقع، خدمة تجميع البيانات SDC، خدمة التحليل SDA، خدمة الرسائل SMS، والمشغّل.",
      { figure: "الشكل (5)", label: "مخطط تدفّق البيانات" }
    ),

    arHeading("١. الضمان الشامل", HeadingLevel.HEADING_2),
    arBody(
      "تتعهد الشركة بتقديم ضمان شامل لجميع الأجهزة مع توفير قطع الغيار اللازمة لمدة عشر سنوات، كما تقدّم فريقاً فنياً متفرّغاً لمدة ساعة قبل التركيب، وذلك لضمان انتقال سلس للنظام الجديد."
    ),

    arHeading("٢. الدعم الفني المستمر", HeadingLevel.HEADING_2),
    arBody(
      "يقدّم فريق الدعم الفني خدماته على مدار الساعة طوال أيام الأسبوع، مع توفير فريق متخصّص للتعامل مع الأحداث الطارئة والتأكد من استمرارية عمل المنظومة بكفاءة عالية."
    ),

    arHeading("٣. المرونة في التشغيل", HeadingLevel.HEADING_2),
    arBody(
      "تتميّز المنظومة بمرونة عالية في التشغيل، حيث يمكن ربطها بأي موقع من المواقع بغضّ النظر عن حدوده الجغرافية، وضبط إعداداتها بحسب احتياجات كل موقع على حدة."
    ),

    arHeading("٤. التقارير التحليلية", HeadingLevel.HEADING_2),
    arBody(
      "توفّر المنظومة تقارير تحليلية نوعية يمكن من خلالها مقارنة معدّلات الاستهلاك للوقود خلال فترات زمنية مختلفة، ومتابعة سجل الأحداث لكل موقع لأي فترة زمنية، مع إمكانية تصدير التقارير بصيغ متعددة (CSV, PDF, Excel)."
    ),

    arHeading("٥. الأمان والموثوقية", HeadingLevel.HEADING_2),
    arBody(
      "بُنيت المنظومة على قاعدة بيانات حديثة وآمنة مع نسخ احتياطي يومي، كما توفّر ميزات أمان متقدمة تشمل: تشفير mTLS للاتصالات، نظام صلاحيات قائم على الأدوار (RBAC)، وسجل تدقيق غير قابل للتعديل لجميع الإجراءات."
    ),

    new Paragraph({ bidirectional: true, spacing: { before: 600 }, children: [] }),
    new Paragraph({
      bidirectional: true,
      alignment: AlignmentType.CENTER,
      spacing: { before: 400, after: 200 },
      border: { top: { style: BorderStyle.DOUBLE, size: 12, color: P.accent, space: 8 } },
      children: [],
    }),
    new Paragraph({
      bidirectional: true,
      alignment: AlignmentType.CENTER,
      spacing: { before: 200, after: 100 },
      children: [new TextRun({
        text: "— نهاية العرض الفني —",
        size: 28,
        bold: true,
        rightToLeft: true,
        font: ARABIC_FONT_BOLD,
        color: P.accent,
      })],
    }),
    new Paragraph({
      bidirectional: true,
      alignment: AlignmentType.CENTER,
      children: [new TextRun({
        text: "شركة اليمن للموبايل — إدارة الوقود والمولّدات",
        size: 22,
        rightToLeft: true,
        font: ARABIC_FONT,
        color: P.mutedText,
        italics: true,
      })],
    }),
  ];
}

// ============================================================================
// SECTION 8 — SYSTEM SCREENSHOTS GALLERY (real captures from running FGMP)
// ============================================================================
function buildSection8_ScreenshotGallery() {
  return [
    arHeading("القسم الثامن: معرض شاشات المنظومة الفعلية", HeadingLevel.HEADING_1),
    dividerLine(),

    arBody(
      "يعرض هذا القسم لقطات حقيقية من المنظومة أثناء التشغيل الفعلي، وقد التُقطت جميع الصور من النظام الحي مع تفعيل الواجهة العربية واتجاه العرض من اليمين إلى اليسار (RTL)، وذلك لإظهار الجاهزية الكاملة للنظام وتجربة المستخدم النهائية بشكل واقعي."
    ),

    // ---- 8.1 Dashboard Operations Center ----
    arHeading("٨.١ لوحة مركز العمليات", HeadingLevel.HEADING_2),
    arBody(
      "تمثّل لوحة مركز العمليات الواجهة الرئيسية للمنظومة، حيث تتجمع فيها جميع المؤشرات الحيوية للنظام بشكل لحظي مع إمكانية الوصول السريع لجميع الوحدات الفرعية."
    ),
    ...arImage(
      "28-01-view-ar.png",
      "الشاشة الرئيسية للوحة مركز العمليات — تعرض شريط الحالة العلوي مع المؤشرات الأربعة (المواقع، الإنذارات، الوقود، المولّدات)، ولافتة الإنذارات الحرجة، ومؤشر الصحة الوطني، والخريطة التفاعلية للمواقع، وتدفّق الأحداث المباشر.",
      { figure: "الشكل (7)", label: "لوحة مركز العمليات" }
    ),
    ...arImage(
      "28-01b-dashboard-mid.png",
      "التمرير لأسفل في لوحة المركز — عرض حالة الأسطول وتوزيع مستويات الوقود واتجاه استهلاك الوقود خلال 24 ساعة وتفصيل المناطق الجغرافية الأربع.",
      { figure: "الشكل (8)", label: "مخططات اللوحة الوسطى" }
    ),
    ...arImage(
      "28-01c-dashboard-bottom.png",
      "تدفّق الأحداث المباشر — عرض لحظي لجميع الأحداث التي تجري في المنظومة مع التصنيف اللوني حسب النوع (اتصال، وقود، مولّد، بطارية، إنذار).",
      { figure: "الشكل (9)", label: "تدفّق الأحداث المباشر" }
    ),

    // ---- 8.2 Sites Management ----
    arHeading("٨.٢ إدارة المواقع", HeadingLevel.HEADING_2),
    arBody(
      "توفّر واجهة إدارة المواقع عرضاً شاملاً لجميع المواقع المنتشرة في الجمهورية اليمنية مع إمكانية البحث والتصفية حسب المنطقة والحالة، والوصول لتفاصيل كل موقع بنقرة واحدة."
    ),
    ...arImage(
      "28-02-view-ar.png",
      "قائمة المواقع — عرض جدولي لجميع المواقع مع المعرف والاسم والمنطقة والحالة ومستوى الوقود وحالة المولّد، مع أدوات البحث والتصفية والإجراءات السريعة.",
      { figure: "الشكل (10)", label: "قائمة المواقع" }
    ),
    ...arImage(
      "28-14-site-detail-ar.png",
      "نافذة تفاصيل الموقع — عرض تفصيلي لموقع واحد يشمل الخزانات والمولّدات والبطاريات والإنذارات النشطة والملاحظات التشغيلية مع إمكانية إصدار أوامر التحكم عن بُعد.",
      { figure: "الشكل (11)", label: "تفاصيل الموقع" }
    ),

    // ---- 8.3 Fuel Monitoring ----
    arHeading("٨.٣ مراقبة الوقود", HeadingLevel.HEADING_2),
    arBody(
      "تُعدّ وحدة مراقبة الوقود من أهم وحدات المنظومة، حيث توفّر رؤية شاملة لمخزون الوقود في جميع المواقع مع تنبيهات لحظية للخزانات الحرجة ومنخفضة المخزون."
    ),
    ...arImage(
      "28-03-view-ar.png",
      "شاشة مراقبة الوقود — عرض إجمالي للمخزون الوطني مع المخطط الدائري لنسب الامتلاء وقائمة الخزانات الحرجة ومنخفضة المخزون والتنبيهات اللحظية.",
      { figure: "الشكل (12)", label: "مراقبة الوقود" }
    ),

    // ---- 8.4 Generators Management ----
    arHeading("٨.٤ إدارة المولّدات", HeadingLevel.HEADING_2),
    arBody(
      "توفّر وحدة إدارة المولّدات مراقبة لحظية لجميع المولّدات الكهربائية في المواقع مع متابعة ساعات التشغيل وحالة الصيانة، وإمكانية إصدار أوامر التشغيل/الإيقاف عن بُعد."
    ),
    ...arImage(
      "28-04-view-ar.png",
      "شاشة إدارة المولّدات — عرض حالة جميع المولّدات مع ساعات التشغيل التراكمية وحالة التشغيل الحالية وإنذارات الأعطال، مع لوحة تنبّؤ بالصيانة الدورية المبنية على ساعات التشغيل.",
      { figure: "الشكل (13)", label: "إدارة المولّدات" }
    ),

    // ---- 8.5 Batteries Monitoring ----
    arHeading("٨.٥ مراقبة البطاريات", HeadingLevel.HEADING_2),
    arBody(
      "تراقب هذه الوحدة مستوى شحن البطاريات في جميع المواقع وتُصدر تنبيهات آلية عند انخفاض الجهد عن الحد الآمن، ممّا يضمن استمرارية التشغيل دون انقطاع."
    ),
    ...arImage(
      "28-05-view-ar.png",
      "شاشة مراقبة البطاريات — عرض حالة بنوك البطاريات مع مستويات الجهد والشحن والتنبيهات المرتبطة بالبطاريات منخفضة الجهد.",
      { figure: "الشكل (14)", label: "مراقبة البطاريات" }
    ),

    // ---- 8.6 Alarms Management ----
    arHeading("٨.٦ إدارة الإنذارات", HeadingLevel.HEADING_2),
    arBody(
      "تُمثّل وحدة إدارة الإنذارات المركز الرئيسي لرصد جميع الأحداث غير الاعتيادية في المنظومة، مع تصنيف الإنذارات حسب الخطورة والحالة وإمكانية تطبيق قواعد الارتباط بين الأحداث."
    ),
    ...arImage(
      "28-06-view-ar.png",
      "شاشة إدارة الإنذارات — عرض جميع الإنذارات النشطة مع التصنيف حسب المستوى (L1/L2/L3) والحالة (مفتوح/تصاعد/مغلَق)، مع أدوات التصفية والتصدير وقواعد الارتباط بين الأحداث.",
      { figure: "الشكل (15)", label: "إدارة الإنذارات" }
    ),

    // ---- 8.7 Inventory & Deliveries ----
    arHeading("٨.٧ المخزون والتوريد", HeadingLevel.HEADING_2),
    arBody(
      "تُدارة من خلال هذه الوحدة جميع عمليات توريد الوقود من المورّدين إلى المواقع، مع متابعة أوامر التوريد والتطابق بين الكميات المطلوبة والمسلّمة والتحقق منها."
    ),
    ...arImage(
      "28-07-view-ar.png",
      "شاشة المخزون والتوريد — عرض طلبات التوريد النشطة مع تفاصيل كل طلب (المورد، السائق، لوحة المركبة، الكمية المطلوبة والمسلّمة، رقم أمر التوريد، الحالة).",
      { figure: "الشكل (16)", label: "المخزون والتوريد" }
    ),

    // ---- 8.8 IoT Devices ----
    arHeading("٨.٨ أجهزة إنترنت الأشياء", HeadingLevel.HEADING_2),
    arBody(
      "توفّر هذه الوحدة إدارة مركزية لجميع أجهزة إنترنت الأشياء المنتشرة في المواقع، مع مراقبة حالة الاتصال والبروتوكولات المستخدمة وإصدار أوامر إعادة التشغيل عن بُعد."
    ),
    ...arImage(
      "28-08-view-ar.png",
      "شاشة أجهزة إنترنت الأشياء — عرض جميع الأجهزة (حساسات وقود، متحكمات مولّدات، حساسات بطاريات، حساسات بيئية) مع حالة الاتصال والبروتوكول (MODBUS_TCP, MODBUS_RTU, SNMP, HTTP).",
      { figure: "الشكل (17)", label: "أجهزة إنترنت الأشياء" }
    ),

    // ---- 8.9 Maintenance ----
    arHeading("٨.٩ الصيانة الدورية", HeadingLevel.HEADING_2),
    arBody(
      "تُدارة من خلال هذه الوحدة جميع تذاكر الصيانة الدورية والطارئة للمولّدات والأجهزة، مع متابعة الحالة والأخصائي المعتمد والإغلاق بعد التحقق."
    ),
    ...arImage(
      "28-09-view-ar.png",
      "شاشة الصيانة — عرض تذاكر الصيانة مع التصنيف حسب النوع (دورية/طارئة) والحالة (مفتوحة/قيد التنفيذ/مغلَقة) مع تتبّع الأخصائي المسؤول والموقع المتأثر.",
      { figure: "الشكل (18)", label: "الصيانة الدورية" }
    ),

    // ---- 8.10 Analytics ----
    arHeading("٨.١٠ التحليلات والإحصائيات", HeadingLevel.HEADING_2),
    arBody(
      "توفّر وحدة التحليلات رؤية عميقة للبيانات التاريخية للمنظومة مع رسوم بيانية تفاعلية تساعد متخذي القرار على فهم الاتجاهات والمقارنات بين الفترات الزمنية والمناطق."
    ),
    ...arImage(
      "28-10-view-ar.png",
      "شاشة التحليلات — عرض رسوم بيانية تفاعلية لاستهلاك الوقود وأداء المولّدات ومعدّلات الإنذارات عبر الزمن مع إمكانية المقارنة بين الفترات والمناطق.",
      { figure: "الشكل (19)", label: "التحليلات والإحصائيات" }
    ),

    // ---- 8.11 Reports ----
    arHeading("٨.١١ التقارير", HeadingLevel.HEADING_2),
    arBody(
      "تُولّد وحدة التقارير تقارير دورية شاملة (يومية/أسبوعية/شهرية) عن جميع جوانب المنظومة مع إمكانية التصدير بصيغ متعددة (CSV, PDF, Excel) لتلبية احتياجات الإدارة العليا."
    ),
    ...arImage(
      "28-11-view-ar.png",
      "شاشة التقارير — عرض قائمة التقارير المتاحة مع إمكانية التوليد والتصدير بصيغ متعددة وجدولة التقارير الدورية التلقائية.",
      { figure: "الشكل (20)", label: "التقارير" }
    ),

    // ---- 8.12 Audit Log ----
    arHeading("٨.١٢ سجل التدقيق", HeadingLevel.HEADING_2),
    arBody(
      "يحتفظ النظام بسجل تدقيق غير قابل للتعديل لجميع الإجراءات التي يقوم بها المستخدمون، ممّا يوفّر الشفافية الكاملة والمساءلة لكل عملية في المنظومة."
    ),
    ...arImage(
      "28-12-view-ar.png",
      "شاشة سجل التدقيق — عرض جميع الإجراءات مع المستخدم القائم بالعمل والطابع الزمني وعنوان IP ونوع الإجراء والكيان المتأثر، مع أدوات التصفية حسب المستخدم والفترة الزمنية.",
      { figure: "الشكل (21)", label: "سجل التدقيق" }
    ),

    // ---- 8.13 Region Drill-down ----
    arHeading("٨.١٣ نافذة تفاصيل المنطقة", HeadingLevel.HEADING_2),
    arBody(
      "تُتيح المنظومة التنقّل التفاعلي من المستوى الوطني إلى مستوى المنطقة ثم الموقع، حيث يمكن النقر على أي منطقة من لوحة المركز لعرض تفاصيلها الكاملة في نافذة جانبية."
    ),
    ...arImage(
      "28-13-region-sheet-ar.png",
      "نافذة تفاصيل المنطقة — عرض تفصيلي لمنطقة المرتفعات الشمالية يشمل المؤشرات الرئيسية والرسوم البيانية لتوزيع المواقع والإنذارات وقائمة المواقع والإنذارات المرتبطة بالمنطقة.",
      { figure: "الشكل (22)", label: "تفاصيل المنطقة" }
    ),

    new Paragraph({ bidirectional: true, spacing: { before: 400 }, children: [] }),
    arBody(
      "تمثّل اللقطات السابقة جزءاً من تجربة المستخدم الفعلية في المنظومة، وتُظهر الجاهزية الكاملة للنظام للتشغيل في بيئة الإنتاج مع دعم كامل للغة العربية واتجاه العرض من اليمين إلى اليسار.",
      { run: { bold: true, color: P.accent } }
    ),

    new Paragraph({ bidirectional: true, children: [new PageBreak()] }),
  ];
}

// ============================================================================
// SECTION 9 — PRICING & COST BREAKDOWN (التسعير وتفصيل التكاليف)
// ============================================================================
function buildSection9_Pricing() {
  return [
    arHeading("القسم التاسع: التسعير وتفصيل التكاليف", HeadingLevel.HEADING_1),
    dividerLine(),

    arBody(
      "يقدّم هذا القسم تفصيلاً شاملاً لتكاليف تنفيذ المنظومة، شاملاً المكوّنات المادية والبرمجية وخدمات التركيب والتدريب والصيانة. وقد بُنيت التكاليف على أساس 52 موقعاً موزّعة على مستوى الجمهورية اليمنية، مع الأخذ بعين الاعتبار جودة الأجهزة المعتمدة والمتانة المطلوبة للعمل في ظروف تشغيلية متنوّعة. جميع الأسعار مقدّمة بالدولار الأمريكي (USD) لسهولة المقارنة وقابلية التحويل."
    ),

    arHeading("أولاً: بنود التكلفة التفصيلية", HeadingLevel.HEADING_2),
    arTable(
      ["#", "بند التكلفة", "الوحدة", "الكمية", "سعر الوحدة (USD)", "الإجمالي (USD)"],
      [
        ["1",  "حساس مستوى الوقود (Ultrasonic / RS485)",  "قطعة",    "78",  "450",   "35,100"],
        ["2",  "متحكّم تشغيل المولّد (Generator Controller)", "قطعة",    "76",  "680",   "51,680"],
        ["3",  "حساس البطارية (Battery Monitor)",         "قطعة",    "52",  "220",   "11,440"],
        ["4",  "الحساس البيئي (درجة الحرارة/الرطوبة)",      "قطعة",    "52",  "180",   "9,360"],
        ["5",  "بوابة الموقع (Site Gateway Controller)",  "جهاز",    "52",  "850",   "44,200"],
        ["6",  "التركيب والمعايرة لكل موقع",                "موقع",    "52",  "1,200", "62,400"],
        ["7",  "الخادم المركزي + رخص البرمجيات (SCDTS/SMMS/SDC/SDA/SMS)", "نظام", "1", "45,000", "45,000"],
        ["8",  "الصيانة الدورية السنوية (السنة الأولى)",     "عقد سنوي", "1",  "24,000", "24,000"],
        ["9",  "برامج التدريب والمواد التدريبية",            "حزمة",    "1",  "8,000",  "8,000"],
        ["10", "بوابة الرسائل القصيرة (SMS Gateway Setup)",  "إعداد",   "1",  "3,500",  "3,500"],
      ]
    ),

    arHeading("ثانياً: ملخّص التكلفة الإجمالية", HeadingLevel.HEADING_2),
    arTable(
      ["البند", "القيمة (USD)", "النسبة من الإجمالي"],
      [
        ["إجمالي المكوّنات المادية (البنود 1-5)",       "151,780", "51.6%"],
        ["إجمالي التركيب والمعايرة (البند 6)",         "62,400",  "21.2%"],
        ["إجمالي البرمجيات والخوادم (البند 7)",         "45,000",  "15.3%"],
        ["إجمالي الصيانة والتدريب والبوابات (البنود 8-10)", "35,500", "12.1%"],
        ["الإجمالي الكلي قبل الضريبة",                  "294,680", "100%"],
        ["ضريبة القيمة المضافة (إن وُجدت)",             "—",       "حسب النظام الضريبي"],
        ["الإجمالي النهائي (شامل التوريد والتركيب)",     "294,680", "—"],
      ]
    ),

    arHeading("ثالثاً: شروط الدفع والضمانات المالية", HeadingLevel.HEADING_2),
    arBullet("دفعة مقدّمة بنسبة 30% عند توقيع العقد لبدء عمليات التوريد."),
    arBullet("دفعة ثانية بنسبة 40% عند اكتمال تركيب 50% من المواقع."),
    arBullet("دفعة ثالثة بنسبة 25% عند التسليم المبدئي وقبول المنظومة."),
    arBullet("دفعة ختامية بنسبة 5% (ضمان أداء) تُدفع بعد انقضاء فترة الضمان الابتدائية (12 شهراً)."),
    arBullet("تُقدَّم كفالة بنكية بنسبة 10% من قيمة العقد سارية طوال فترة التنفيذ."),
    arBullet("أسعار الأجهزة مثبّتة لمدة 90 يوماً من تاريخ تقديم العرض، وتُراجَع أسعار الصيانة السنوية بعد السنة الأولى."),
    arBullet("يشمل السعر جميع البرامج والتحديثات الأساسية لمدة سنة كاملة من تاريخ التسليم، مع إمكانية تجديد عقد الصيانة سنوياً."),

    arBody(
      "ملاحظة: الأسعار المذكورة أعلاه تقديرية وقابلة للتفاوض النهائي بناءً على نطاق العمل الفعلي وعدد المواقع المحدّد وكذلك خيارات التخصيص الإضافية التي قد تطلبها الجهة المستفيدة.",
      { run: { italics: true, color: P.mutedText } }
    ),

    new Paragraph({ bidirectional: true, children: [new PageBreak()] }),
  ];
}

// ============================================================================
// SECTION 10 — IMPLEMENTATION TIMELINE (الجدول الزمني للتنفيذ)
// ============================================================================
function buildSection10_Timeline() {
  return [
    arHeading("القسم العاشر: الجدول الزمني للتنفيذ", HeadingLevel.HEADING_1),
    dividerLine(),

    arBody(
      "تمتدّ فترة تنفيذ المشروع على مدى 26 أسبوعاً (ما يقارب ستة أشهر)، مقسّمة إلى ست مراحل متتابعة تضمن تنفيذاً منظّماً ومراقَباً مع نقاط فاصلة واضحة لقياس التقدّم واعتماد المرحلة قبل الانتقال إلى التي تليها. يُلتزَم في كل مرحلة بمعايير الجودة والاختبار والموثوقية قبل الاعتماد النهائي."
    ),

    arHeading("أولاً: مراحل التنفيذ", HeadingLevel.HEADING_2),
    arTable(
      ["المرحلة", "الوصف", "المدة", "البداية", "النهاية", "الاعتماديات"],
      [
        ["المرحلة 1", "المسح الميداني وتجهيز المواقع",        "4 أسابيع",  "الأسبوع 1",  "الأسبوع 4",  "توقيع العقد + الدفعة المقدّمة"],
        ["المرحلة 2", "تركيب الأجهزة في المواقع النموذجية (Pilot)", "4 أسابيع",  "الأسبوع 5",  "الأسبوع 8",  "اكتمال المرحلة 1"],
        ["المرحلة 3", "التوسّع في تركيب الأجهزة بجميع المواقع", "8 أسابيع",  "الأسبوع 9",  "الأسبوع 16", "اعتماد نتائج المرحلة 2"],
        ["المرحلة 4", "إعداد البرمجيات والتكامل المركزي",     "4 أسابيع",  "الأسبوع 17", "الأسبوع 20", "اكتمال تركيب 80% من المواقع"],
        ["المرحلة 5", "الاختبار الشامل والاستلام المبدئي",     "4 أسابيع",  "الأسبوع 21", "الأسبوع 24", "اكتمال المرحلة 4"],
        ["المرحلة 6", "التدريب والتسليم النهائي",             "2 أسبوعين", "الأسبوع 25", "الأسبوع 26", "اعتماد نتائج المرحلة 5"],
      ]
    ),

    arHeading("ثانياً: المعالم الرئيسية (Milestones)", HeadingLevel.HEADING_2),
    arBullet("M1 (الأسبوع 4): تقرير المسح الميداني + خطة التركيب المفصّلة معتمدة."),
    arBullet("M2 (الأسبوع 8): اعتماد التركيب في 5 مواقع نموذجية وتشغيلها بنجاح."),
    arBullet("M3 (الأسبوع 16): اكتمال تركيب جميع المواقع البالغ عددها 52 وتوصيلها بالخادم."),
    arBullet("M4 (الأسبوع 20): تشغيل البرمجيات والتكامل المركزي ومطابقة الخدمات."),
    arBullet("M5 (الأسبوع 24): اكتمال الاختبارات الوظيفية والأدائية وتقرير الاستلام المبدئي."),
    arBullet("M6 (الأسبوع 26): التدريب الكامل + التسليم النهائي واعتماد المنظومة للإنتاج."),

    arHeading("ثالثاً: إدارة المخاطر الزمنية", HeadingLevel.HEADING_2),
    arBody(
      "تتضمّن خطة التنفيذ هامشاً زمنياً احتياطياً قدره أسبوعان لاستيعاب أيّ تأخيرات غير متوقّعة ناتجة عن ظروف الطقس أو تأخّر التوريد أو صعوبات الوصول لبعض المواقع النائية. كما يُعقد اجتماع متابعة أسبوعي مع الجهة المستفيدة لمراجعة التقدّم ومعالجة أي معوّقات فوراً."
    ),

    new Paragraph({ bidirectional: true, children: [new PageBreak()] }),
  ];
}

// ============================================================================
// SECTION 11 — PROJECT TEAM (فريق العمل والكوادر)
// ============================================================================
function buildSection11_Team() {
  return [
    arHeading("القسم الحادي عشر: فريق العمل والكوادر", HeadingLevel.HEADING_1),
    dividerLine(),

    arBody(
      "تتعهد الشركة بتوفير فريق عمل متخصّص وذو خبرة عالية لتنفيذ المشروع بكفاءة، يتألّف من كوادر هندسية وتقنية وإدارية معتمدة، مع ضمان استمرارية الدعم بعد التسليم. وفيما يلي تفصيل لأعضاء الفريق الرئيسيين ومؤهّلاتهم وأدوارهم في المشروع."
    ),

    arHeading("أولاً: الهيكل التنظيمي لفريق المشروع", HeadingLevel.HEADING_2),
    arTable(
      ["#", "الدور", "العدد", "المؤهّلات", "سنوات الخبرة", "الوصف"],
      [
        ["1", "مدير المشروع (Project Manager)",       "1", "بكالوريوس هندسة + شهادة PMP",        "12+ سنة", "إدارة المشروع ككل، التخطيط، المتابعة، التواصل مع الجهة المستفيدة"],
        ["2", "القائد الفني (Technical Lead)",        "1", "بكالوريوس هندسة حاسوب/اتصالات",      "10+ سنة",  "الإشراف الفني على التصميم والتنفيذ وحلّ المشكلات التقنية"],
        ["3", "مهندسو ميدانيون (Field Engineers)",    "4", "بكالوريوس هندسة كهربائية/ميكانيكية", "5+ سنوات", "تركيب ومعايرة الأجهزة في المواقع + اختبار التشغيل"],
        ["4", "مطوّرو برمجيات (Software Developers)", "2", "بكالوريوس علوم حاسوب",                "6+ سنوات", "تطوير وتكامل البرمجيات + واجهات الويب والجوال"],
        ["5", "مهندس ضمان الجودة (QA Engineer)",      "1", "بكالوريوس علوم حاسوب + ISTQB",        "4+ سنوات", "إعداد خطط الاختبار وتنفيذها + التحقّق من المتطلبات"],
        ["6", "منسّق التدريب (Training Coordinator)","1", "بكالوريوس + شهادة تدريب معتمدة",       "6+ سنوات", "إعداد وتنفيذ برامج التدريب + إعداد الأدلة والمواد"],
        ["7", "أخصائي دعم فني (Support Specialist)",  "2", "بكالوريوس + شهادة ITIL",              "3+ سنوات", "الدعم الفني المستمر بعد التسليم + استقبال البلاغات"],
      ]
    ),

    arHeading("ثانياً: الالتزامات تجاه الفريق", HeadingLevel.HEADING_2),
    arBullet("يضمن توفّر جميع أعضاء الفريق طوال فترة التنفيذ دون انقطاع يؤثّر على الجدول الزمني."),
    arBullet("يتم استبدال أي عضو يتعذّر استمراره بشخص آخر بنفس المؤهّلات بعد موافقة الجهة المستفيدة."),
    arBullet("يُعقد اجتماع تنسيقي أسبوعي بحضور مدير المشروع وممثّل الجهة المستفيدة لمراجعة التقدّم."),
    arBullet("يتوفّر فريق الدعم الفني على مدار الساعة طوال أيام الأسبوع بعد التسليم النهائي."),
    arBullet("يقدّم الفريق تقارير دورية شهرية عن حالة المنظومة والأداء والصيانة الوقائية."),

    new Paragraph({ bidirectional: true, children: [new PageBreak()] }),
  ];
}

// ============================================================================
// SECTION 12 — SLA (اتفاقية مستوى الخدمة)
// ============================================================================
function buildSection12_SLA() {
  return [
    arHeading("القسم الثاني عشر: اتفاقية مستوى الخدمة (SLA)", HeadingLevel.HEADING_1),
    dividerLine(),

    arBody(
      "تتعهّد الشركة بالتزامها باتفاقية مستوى خدمة (Service Level Agreement) واضحة وقابلة للقياس، تضمن جودة الأداء واستمرارية الخدمة وسرعة الاستجابة لأي أحداث غير اعتيادية. وتشمل الاتفاقية مؤشرات الأداء الرئيسية (KPIs) الموضّحة أدناه، مع آليات قياس واضحة وعقوبات محدّدة في حال الإخلال بأي من البنود."
    ),

    arHeading("أولاً: مؤشرات مستوى الخدمة (KPIs)", HeadingLevel.HEADING_2),
    arTable(
      ["#", "المؤشر", "القيمة المستهدفة", "آلية القياس", "الفترة"],
      [
        ["1", "نسبة توافر النظام (System Uptime)",         "99.5%",      "مراقبة آلية لخادم المنظومة",         "شهري"],
        ["2", "زمن إشعار الإنذار (Alarm Notification Time)","أقل من 30 ثانية","تسجيل طابع زمني للإنذار والإشعار","لكل إنذار"],
        ["3", "فترة تحديث البيانات (Data Refresh Interval)","5 ثوانٍ",    "تسجيل آخر قراءة لكل حساس",          "لحظي"],
        ["4", "زمن استجابة الدعم الفني",                  "24/7 خلال 15 دقيقة","نظام تذاكر الدعم",            "لكل بلاغ"],
        ["5", "زمن حلّ المشكلات الحرجة",                 "أقل من 4 ساعات","نظام تذاكر الدعم + سجل الحلّ",     "لكل بلاغ حرج"],
        ["6", "زمن حلّ المشكلات غير الحرجة",             "أقل من 48 ساعة","نظام تذاكر الدعم + سجل الحلّ",     "لكل بلاغ"],
        ["7", "تقرير الأداء الشهري (Uptime Report)",      "تقرير شهري","تقرير آلي يُرسَل خلال أول 5 أيام من الشهر التالي","شهري"],
        ["8", "نسخ احتياطي يومي للبيانات",              "100% يومياً","سجل النسخ + اختبار الاستعادة",      "يومي"],
      ]
    ),

    arHeading("ثانياً: بنود العقوبات (Penalty Clauses)", HeadingLevel.HEADING_2),
    arBody(
      "في حال إخلال الشركة بأي من مؤشرات مستوى الخدمة المذكورة أعلاه، تُطبَّق العقوبات التالية بناءً على درجة الإخلال ومدّته:"
    ),
    arBullet("انخفاض نسبة التوافر عن 99.5% خلال شهر: خصم 1% من رسوم الصيانة الشهرية عن كل 0.5% انخفاض."),
    arBullet("تأخّر إشعار الإنذار عن 30 ثانية لأكثر من 5 إنذارات في الشهر: خصم 2% من رسوم الصيانة الشهرية."),
    arBullet("تأخّر الاستجابة لبلاغ حرج عن 15 دقيقة: خصم 0.5% عن كل حالة تأخير."),
    arBullet("تأخّر حلّ مشكلة حرجة عن 4 ساعات: خصم 1% عن كل ساعة تأخير إضافية."),
    arBullet("إخلال متكرّر بثلاثة مؤشرات أو أكثر في الشهر نفسه: مراجعة عقدية شاملة وحقّ الجهة المستفيدة في إنهاء العقد دون تعويض."),
    arBullet("تُحتسب العقوبات بشكل تراكمي شهرياً بحدّ أقصى 25% من رسوم الصيانة الشهرية."),

    arHeading("ثالثاً: آلية التحقّق والتقارير", HeadingLevel.HEADING_2),
    arBody(
      "تُولَّد تقارير مستوى الخدمة آلياً من النظام وتُرسَل إلى الجهة المستفيدة خلال الأيام الخمسة الأولى من كل شهر. كما يحقّ للجهة المستفيدة طلب تقارير مخصّصة في أي وقت، وإجراء مراجعات ميدانية دورية للتأكّد من التزام الشركة ببنود الاتفاقية. يتم حلّ أي خلاف حول قياس المؤشرات عبر لجنة فنية مشتركة، مع إمكانية الاستعانة بطرف ثالث محايد للتحكيم التقني."
    ),

    new Paragraph({ bidirectional: true, children: [new PageBreak()] }),
  ];
}

// ============================================================================
// SECTION 13 — TESTING, ACCEPTANCE & TRAINING (الاختبار والاستلام والتدريب)
// ============================================================================
function buildSection13_TestingTraining() {
  return [
    arHeading("القسم الثالث عشر: الاختبار والاستلام والتدريب", HeadingLevel.HEADING_1),
    dividerLine(),

    arBody(
      "يخضع المشروع لمنهجية اختبار شاملة تضمن مطابقة المنظومة لجميع المتطلبات الفنية والأدائية والأمنية قبل التسليم النهائي. كما تُتَّبع ثلاثة معالم للاستلام معتمدة من قبل الجهة المستفيدة، يتبعها برنامج تدريبي متكامل لضمان قدرة المستخدمين على تشغيل المنظومة بكفاءة عالية."
    ),

    arHeading("أولاً: معايير الاختبار (Testing Criteria)", HeadingLevel.HEADING_2),
    arTable(
      ["نوع الاختبار", "النطاق", "المعيار", "طريقة الاختبار"],
      [
        ["الاختبار الوظيفي (Functional)",     "جميع وظائف المنظومة",       "مطابقة 100% لمتطلبات العرض",      "سيناريوهات اختبار لكل وظيفة"],
        ["اختبار الأداء (Performance)",        "زمن الاستجابة والإنتاجية",  "تحديث كل 5 ثوانٍ + 99.5% توافر",  "أدوات قياس الحمل + اختبار الضغط"],
        ["اختبار الأمان (Security)",           "المصادقة + التشفير + RBAC",  "مطابقة معايير OWASP + mTLS",      "اختبار اختراق + مراجعة الكود"],
        ["اختبار التكامل (Integration)",       "ربط الأجهزة بالخادم",       "اكتمال نقل البيانات 100%",        "اختبار كل موقع على حدة"],
        ["اختبار المستخدم (UAT)",              "سيناريوهات العمل الفعلية",  "موافقة ممثّلي الجهة المستفيدة",   "سيناريوهات واقعية على بيئة الإنتاج"],
      ]
    ),

    arHeading("ثانياً: معالم الاستلام (Acceptance Milestones)", HeadingLevel.HEADING_2),
    arBullet("SAT (Site Acceptance Test): استلام كل موقع على حدة بعد تركيب الأجهزة واختبار التشغيل المحلي، يُوقَّع من قبل ممثّل الجهة المستفيدة في الموقع."),
    arBullet("UAT (User Acceptance Test): استلام المنظومة كاملة من قبل المستخدمين النهائيين بعد اختبار جميع السيناريوهات الوظيفية والأدائية، يُوقَّع من قبل لجنة الاستلام."),
    arBullet("الاستلام النهائي (Final Acceptance): يُمنَح بعد انقضاء فترة التشغيل التجريبي (30 يوماً) دون اكتشاف أي عيوب جوهرية، ويُعتمد به الانتقال إلى مرحلة الضمان والصيانة."),

    arHeading("ثالثاً: خطة التدريب (Training Plan)", HeadingLevel.HEADING_2),
    arTable(
      ["الدورة", "الفئة المستهدفة", "المدة", "المحتوى الرئيسي", "عدد المتدرّبين"],
      [
        ["دورة المشغّلين",      "مستخدمو لوحة الويب والمشغّلون",  "يومان (16 ساعة)", "تشغيل الواجهة + إدارة الإنذارات + إصدار الأوامر + التقارير اليومية", "10-15 متدرّباً"],
        ["دورة المديرين",       "مدراء النظام والمسؤولون",        "3 أيام (24 ساعة)", "إدارة المستخدمين + RBAC + إعداد المواقع + النسخ الاحتياطي + مراقبة الأداء", "5-8 متدرّبين"],
        ["الدورة التنفيذية",    "الإدارة العليا + متخذو القرار",  "نصف يوم (4 ساعات)", "نظرة عامة + KPIs + قراءة التقارير التحليلية + اتخاذ القرارات", "5-10 مدراء"],
      ]
    ),

    arHeading("رابعاً: مواد التدريب والوثائق", HeadingLevel.HEADING_2),
    arBullet("دليل المستخدم النهائي (User Manual) باللغتين العربية والإنجليزية — نسخة مطبوعة وإلكترونية."),
    arBullet("دليل المدير الفني (Admin Guide) يغطّي الإعدادات والإدارة والصيانة الوقائية."),
    arBullet("دليل تركيب الأجهزة (Installation Guide) للمرجعية المستقبلية."),
    arBullet("فيديوهات تدريبية مسجّلة لجميع الوظائف الرئيسية في المنظومة."),
    arBullet("دعم مباشر خلال أول 30 يوماً من التشغيل الفعلي مع تواجد مهندس في مقرّ الجهة المستفيدة."),

    arHeading("خامساً: شروط الضمان (Warranty Terms)", HeadingLevel.HEADING_2),
    arBody(
      "تقدّم الشركة ضماناً شاملاً لجميع المكوّنات المادية والبرمجية لمدة 10 سنوات كاملة من تاريخ الاستلام النهائي، يشمل استبدال الأجهزة المعطوبة وتحديث البرمجيات والإصلاحات الفنية دون أيّ رسوم إضافية، مع توفّر قطع الغيار خلال 48 ساعة من البلاغ. كما تشمل فترة الضمان الزيارات الميدانية الدورية للصيانة الوقائية كل 6 أشهر لكل موقع."
    ),
  ];
}

// ============================================================================
// FOOTER & HEADER
// ============================================================================

// Body page count — kept in sync with the actual body page count after the
// trailing-page-break cleanup. Used as a literal in the body footer because
// LibreOffice's PDF export does NOT evaluate the SECTIONPAGES field
// (PageNumber.TOTAL_PAGES_IN_SECTION renders blank), while NUMPAGES
// (PageNumber.TOTAL_PAGES) returns the absolute PDF page count (49) which
// does not match the body's restarted "1..N" counter. Hardcoding the body
// count yields a consistent "صفحة X من 45" footer across all body pages.
// Update this constant if the body content changes (regenerate docx + PDF
// and re-count body pages).
const BODY_PAGE_COUNT = 45;

// totalField: PageNumber.TOTAL_PAGES for front matter (whole document, which
// LibreOffice evaluates correctly), or a literal string (e.g. "45") for the
// body section to avoid the LibreOffice SECTIONPAGES rendering bug.
// docx's TextRun children-array accepts both PageNumber constants (treated
// as field instructions) and arbitrary strings (treated as inline text).
function buildFooter(totalField = PageNumber.TOTAL_PAGES) {
  return new Footer({
    children: [new Paragraph({
      bidirectional: true,
      alignment: AlignmentType.CENTER,
      children: [
        new TextRun({
          text: "صفحة ",
          size: 18,
          rightToLeft: true,
          font: ARABIC_FONT,
          color: P.footerColor,
        }),
        new TextRun({
          children: [PageNumber.CURRENT],
          size: 18,
          font: { ascii: "Arial", hAnsi: "Arial" },
          color: P.footerColor,
        }),
        new TextRun({
          text: " من ",
          size: 18,
          rightToLeft: true,
          font: ARABIC_FONT,
          color: P.footerColor,
        }),
        new TextRun({
          children: [totalField],
          size: 18,
          font: { ascii: "Arial", hAnsi: "Arial" },
          color: P.footerColor,
        }),
      ],
    })],
  });
}

function buildHeader() {
  return new Header({
    children: [new Paragraph({
      bidirectional: true,
      alignment: AlignmentType.RIGHT,
      border: { bottom: { style: BorderStyle.SINGLE, size: 4, color: P.accent, space: 4 } },
      children: [
        new TextRun({
          text: "عرض فني — شركة اليمن للموبايل",
          size: 18,
          rightToLeft: true,
          font: ARABIC_FONT,
          color: P.mutedText,
          italics: true,
        }),
      ],
    })],
  });
}

// ============================================================================
// DOCUMENT ASSEMBLY
// ============================================================================

const doc = new Document({
  creator: "FGMP — Fuel & Generator Monitoring Platform",
  title: "عرض فني متكامل لمنظومة مراقبة وإدارة الوقود والتحكم بالمولّدات",
  description: "Technical proposal for fuel monitoring and generator control system — Yemen Mobile",
  subject: "Technical Proposal — Fuel & Generator Monitoring",

  styles: {
    default: {
      document: {
        run: {
          font: ARABIC_FONT,
          size: 24,
          color: P.bodyText,
          rightToLeft: true,
        },
        paragraph: {
          spacing: { line: 360 },
          bidirectional: true,
        },
      },
      heading1: {
        run: {
          font: ARABIC_FONT_BOLD,
          size: 36,
          bold: true,
          color: P.headingText,
          rightToLeft: true,
        },
        paragraph: {
          spacing: { before: 480, after: 180, line: 360 },
          bidirectional: true,
          alignment: AlignmentType.RIGHT,
        },
      },
      heading2: {
        run: {
          font: ARABIC_FONT_BOLD,
          size: 30,
          bold: true,
          color: P.headingText,
          rightToLeft: true,
        },
        paragraph: {
          spacing: { before: 360, after: 180, line: 360 },
          bidirectional: true,
          alignment: AlignmentType.RIGHT,
        },
      },
      heading3: {
        run: {
          font: ARABIC_FONT_BOLD,
          size: 26,
          bold: true,
          color: P.headingText,
          rightToLeft: true,
        },
        paragraph: {
          spacing: { before: 240, after: 120, line: 360 },
          bidirectional: true,
          alignment: AlignmentType.RIGHT,
        },
      },
    },
  },

  sections: [
    // Section 1: Cover page
    {
      properties: {
        page: {
          margin: { top: 0, bottom: 0, left: 0, right: 0 },
          size: { width: 11906, height: 16838 },
        },
      },
      children: buildCover(),
    },
    // Section 2: TOC
    {
      properties: {
        page: {
          margin: { top: 1440, bottom: 1440, left: 1417, right: 1701 },
          size: { width: 11906, height: 16838 },
        },
      },
      headers: { default: buildHeader() },
      footers: { default: buildFooter(PageNumber.TOTAL_PAGES) },
      children: buildTOC(),
    },
    // Section 3: Body content
    {
      properties: {
        page: {
          margin: { top: 1440, bottom: 1440, left: 1417, right: 1701 },
          size: { width: 11906, height: 16838 },
          pageNumbers: { start: 1, formatType: NumberFormat.DECIMAL },
        },
      },
      headers: { default: buildHeader() },
      footers: { default: buildFooter(String(BODY_PAGE_COUNT)) },
      children: [
        ...buildSection1_Introduction(),
        ...buildSection2_ProjectDefinition(),
        ...buildSection3_Assumptions(),
        ...buildSection4_Features(),
        ...buildSection5_Hardware(),
        ...buildSection6_Software(),
        ...buildSection7_GeneralAdvantages(),
        ...buildSection8_ScreenshotGallery(),
        ...buildSection9_Pricing(),
        ...buildSection10_Timeline(),
        ...buildSection11_Team(),
        ...buildSection12_SLA(),
        ...buildSection13_TestingTraining(),
      ],
    },
  ],
});

// ============================================================================
// GENERATE
// ============================================================================
const OUTPUT_PATH = "/home/z/my-project/download/FGMP_Arabic_Technical_Proposal.docx";

Packer.toBuffer(doc).then((buf) => {
  fs.writeFileSync(OUTPUT_PATH, buf);
  const stats = fs.statSync(OUTPUT_PATH);
  console.log(`✓ Document generated: ${OUTPUT_PATH}`);
  console.log(`  Size: ${(stats.size / 1024).toFixed(1)} KB`);
  console.log(`  Language: Arabic (RTL)`);
  console.log(`  Sections: Cover + TOC + 13 body sections`);
  console.log(`  Embedded images: 18 (16 real screenshots + 2 generated diagrams)`);
}).catch((err) => {
  console.error("✗ Generation failed:", err);
  process.exit(1);
});
