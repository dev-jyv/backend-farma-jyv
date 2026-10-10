import { SalesReportEmail } from '../emails/sales-report.email';
import { sendReportEmail } from './email.service';
import { buildReportPdf } from './report-pdf.service';
import {
    buildDailyReport,
    buildMonthlyReport,
    getPreviousMonth,
    getYesterdayIsoDate,
    SalesReport,
} from './sales-reports.service';

const dispatchReport = async (report: SalesReport, filename: string): Promise<void> => {
    const pdf = await buildReportPdf(report);
    await sendReportEmail({
        subject: `${report.title} — ${report.periodLabel}`,
        react: SalesReportEmail({ report }),
        attachment: { filename, content: pdf },
    });
};

export const sendDailySalesReport = async (isoDate?: string): Promise<{ date: string }> => {
    const date = isoDate ?? getYesterdayIsoDate();
    const report = await buildDailyReport(date);
    await dispatchReport(report, `ventas-diarias-${date}.pdf`);
    return { date };
};

export const sendMonthlySalesReport = async (
    year?: number,
    month?: number,
): Promise<{ year: number; month: number }> => {
    const period = year && month ? { year, month } : getPreviousMonth();
    const report = await buildMonthlyReport(period.year, period.month);
    const paddedMonth = String(period.month).padStart(2, '0');
    await dispatchReport(report, `ventas-mensuales-${period.year}-${paddedMonth}.pdf`);
    return period;
};
