import PDFDocument from 'pdfkit';
import fs from 'node:fs';
import path from 'node:path';
import type { RedTeamReport, AttackResult, AttackCategoryId } from '../types.js';
import { getCategoryById } from './vectors.js';

const COLORS = {
  green: '#2E7D32',
  yellow: '#F9A825',
  red: '#C62828',
  darkGray: '#333333',
  medGray: '#666666',
  lightGray: '#EEEEEE',
  white: '#FFFFFF',
  black: '#000000',
} as const;

function scoreColor(score: number): string {
  if (score >= 80) return COLORS.green;
  if (score >= 50) return COLORS.yellow;
  return COLORS.red;
}

function severityColor(severity: string): string {
  switch (severity) {
    case 'critical': return COLORS.red;
    case 'high': return '#E65100';
    case 'medium': return COLORS.yellow;
    default: return COLORS.green;
  }
}

function formatDuration(ms: number): string {
  const s = ms / 1000;
  if (s < 60) return `${s.toFixed(1)}s`;
  const m = Math.floor(s / 60);
  const rem = (s % 60).toFixed(0);
  return `${m}m ${rem}s`;
}

function truncate(text: string, max: number): string {
  if (text.length <= max) return text;
  return text.slice(0, max) + '...';
}

export async function generatePdfReport(report: RedTeamReport, outputPath: string): Promise<void> {
  const resolvedPath = path.resolve(outputPath);
  const dir = path.dirname(resolvedPath);
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }

  return new Promise<void>((resolve, reject) => {
    const doc = new PDFDocument({ size: 'A4', margin: 50 });
    const stream = fs.createWriteStream(resolvedPath);
    doc.pipe(stream);

    stream.on('finish', resolve);
    stream.on('error', reject);

    // --- Header ---
    doc
      .fontSize(22)
      .font('Helvetica-Bold')
      .fillColor(COLORS.darkGray)
      .text('PROWL RED-TEAM REPORT', { align: 'center' });
    doc.moveDown(0.5);

    doc
      .fontSize(9)
      .font('Helvetica')
      .fillColor(COLORS.medGray)
      .text(
        `Run ID: ${report.run_id}  |  Target: ${report.target_agent}  |  Model: ${report.model}`,
        { align: 'center' },
      );
    doc.text(
      `Generated: ${report.timestamp}  |  Duration: ${formatDuration(report.duration_ms)}`,
      { align: 'center' },
    );
    doc.moveDown(1);

    // --- Summary Box ---
    const boxY = doc.y;
    const boxW = doc.page.width - 100;
    doc.save();
    doc
      .roundedRect(50, boxY, boxW, 80, 4)
      .fillAndStroke(COLORS.lightGray, '#CCCCCC');
    doc.restore();

    const col1 = 70;
    const col2 = 200;
    const col3 = 330;
    const row1 = boxY + 14;
    const row2 = boxY + 48;

    doc.font('Helvetica-Bold').fontSize(10).fillColor(COLORS.darkGray);
    doc.text('Total Attacks', col1, row1);
    doc.text('Breaches', col2, row1);
    doc.text('Defended', col3, row1);

    doc.font('Helvetica').fontSize(18);
    doc.fillColor(COLORS.darkGray).text(String(report.total_attacks), col1, row1 + 14);
    doc.fillColor(report.successful_attacks > 0 ? COLORS.red : COLORS.green)
      .text(String(report.successful_attacks), col2, row1 + 14);
    doc.fillColor(COLORS.green).text(String(report.failed_attacks), col3, row1 + 14);

    // Defense score on the right
    const scoreX = 420;
    doc.font('Helvetica-Bold').fontSize(10).fillColor(COLORS.darkGray);
    doc.text('Defense Score', scoreX, row1);
    doc.fontSize(26).fillColor(scoreColor(report.defense_score));
    doc.text(`${report.defense_score}%`, scoreX, row1 + 10);

    if (report.errors > 0) {
      doc.fontSize(9).font('Helvetica').fillColor(COLORS.medGray);
      doc.text(`(${report.errors} error${report.errors !== 1 ? 's' : ''})`, scoreX, row2 + 10);
    }

    doc.y = boxY + 95;
    doc.x = 50;

    // --- Category Breakdown Table ---
    doc.font('Helvetica-Bold').fontSize(14).fillColor(COLORS.darkGray);
    doc.text('Category Breakdown');
    doc.moveDown(0.4);

    const categories = buildCategoryStats(report.results);
    const tableX = 50;
    const colWidths = [200, 80, 80, 100];
    const headers = ['Category', 'Attacks', 'Breaches', 'Defense Rate'];
    let tableY = doc.y;

    // Header row
    doc.save();
    doc.rect(tableX, tableY, colWidths.reduce((a, b) => a + b, 0), 20).fill(COLORS.darkGray);
    doc.restore();
    doc.font('Helvetica-Bold').fontSize(9).fillColor(COLORS.white);
    let hx = tableX + 6;
    for (let i = 0; i < headers.length; i++) {
      doc.text(headers[i], hx, tableY + 5, { width: colWidths[i] - 12 });
      hx += colWidths[i];
    }
    tableY += 20;

    // Data rows
    doc.font('Helvetica').fontSize(9);
    for (const cat of categories) {
      const rowBg = categories.indexOf(cat) % 2 === 0 ? COLORS.white : COLORS.lightGray;
      doc.save();
      doc.rect(tableX, tableY, colWidths.reduce((a, b) => a + b, 0), 18).fill(rowBg);
      doc.restore();

      hx = tableX + 6;
      doc.fillColor(COLORS.darkGray).text(cat.name, hx, tableY + 4, { width: colWidths[0] - 12 });
      hx += colWidths[0];
      doc.text(String(cat.total), hx, tableY + 4, { width: colWidths[1] - 12 });
      hx += colWidths[1];
      doc.fillColor(cat.breaches > 0 ? COLORS.red : COLORS.green)
        .text(String(cat.breaches), hx, tableY + 4, { width: colWidths[2] - 12 });
      hx += colWidths[2];
      const rate = cat.total > 0 ? Math.round(((cat.total - cat.breaches) / cat.total) * 100) : 100;
      doc.fillColor(scoreColor(rate))
        .text(`${rate}%`, hx, tableY + 4, { width: colWidths[3] - 12 });
      tableY += 18;
    }

    doc.y = tableY + 15;
    doc.x = 50;

    // --- Detailed Results ---
    doc.font('Helvetica-Bold').fontSize(14).fillColor(COLORS.darkGray);
    doc.text('Detailed Results');
    doc.moveDown(0.4);

    for (const result of report.results) {
      ensureSpace(doc, 120);

      const verdictLabel = result.verdict.success ? 'BREACH' : 'DEFENDED';
      const verdictColor = result.verdict.success ? COLORS.red : COLORS.green;
      const catName = getCategoryById(result.category)?.name ?? result.category;

      // Result header bar
      const barY = doc.y;
      doc.save();
      doc.rect(50, barY, doc.page.width - 100, 18).fill(verdictColor);
      doc.restore();

      doc.font('Helvetica-Bold').fontSize(9).fillColor(COLORS.white);
      doc.text(
        `${verdictLabel}  |  ${catName}  |  ${result.technique}  |  Confidence: ${(result.verdict.confidence * 100).toFixed(0)}%  |  Severity: ${result.verdict.severity}`,
        56, barY + 4,
        { width: doc.page.width - 112 },
      );
      doc.y = barY + 22;
      doc.x = 50;

      // Attack prompt
      doc.font('Helvetica-Bold').fontSize(8).fillColor(COLORS.medGray);
      doc.text('Attack Prompt:');
      doc.font('Helvetica').fontSize(8).fillColor(COLORS.darkGray);
      doc.text(truncate(result.attack_prompt, 500), { width: doc.page.width - 100 });
      doc.moveDown(0.3);

      // Reasoning
      if (result.verdict.reasoning) {
        doc.font('Helvetica-Bold').fontSize(8).fillColor(COLORS.medGray);
        doc.text('Reasoning:');
        doc.font('Helvetica').fontSize(8).fillColor(COLORS.darkGray);
        doc.text(truncate(result.verdict.reasoning, 400), { width: doc.page.width - 100 });
        doc.moveDown(0.3);
      }

      // Indicators
      if (result.verdict.indicators.length > 0) {
        doc.font('Helvetica-Bold').fontSize(8).fillColor(COLORS.medGray);
        doc.text('Indicators:');
        doc.font('Helvetica').fontSize(8).fillColor(COLORS.darkGray);
        for (const ind of result.verdict.indicators) {
          doc.text(`  - ${ind}`, { width: doc.page.width - 110 });
        }
      }

      doc.moveDown(0.6);
    }

    // --- Footer ---
    ensureSpace(doc, 30);
    doc.moveDown(1);
    doc
      .fontSize(8)
      .font('Helvetica')
      .fillColor(COLORS.medGray)
      .text(`Generated by Prowl  |  ${new Date().toISOString()}`, { align: 'center' });

    doc.end();
  });
}

interface CategoryStat {
  name: string;
  total: number;
  breaches: number;
}

function buildCategoryStats(results: AttackResult[]): CategoryStat[] {
  const map = new Map<AttackCategoryId, CategoryStat>();

  for (const r of results) {
    let stat = map.get(r.category);
    if (!stat) {
      const cat = getCategoryById(r.category);
      stat = { name: cat?.name ?? r.category, total: 0, breaches: 0 };
      map.set(r.category, stat);
    }
    stat.total++;
    if (r.verdict.success) stat.breaches++;
  }

  return Array.from(map.values());
}

function ensureSpace(doc: PDFKit.PDFDocument, needed: number): void {
  const remaining = doc.page.height - doc.page.margins.bottom - doc.y;
  if (remaining < needed) {
    doc.addPage();
  }
}
