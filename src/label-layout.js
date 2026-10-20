const mm = n => n * 72 / 25.4;
export async function drawLabels(doc, cards, settings, makeQr) {
  const {widthMm=76.2,heightMm=50.8}=settings;
  for (const c of cards) {
    doc.addPage();
    const w = mm(widthMm), h = mm(heightMm), compact = heightMm < 80;
    doc.lineWidth(.8).strokeColor('#781b39').rect(mm(2), mm(2), w - mm(4), h - mm(4)).stroke();
    doc.fillColor('#781b39').font('Helvetica-Bold').fontSize(compact ? 11 : 12)
      .text('FAIZE HUSSEINI', mm(4), mm(compact ? 3.5 : 6), { width: w - mm(8), align: 'center', lineBreak: false });
    doc.fontSize(compact ? 8 : 10).text('KARBALA MUALLA', mm(4), mm(compact ? 8.2 : 11), { width: w - mm(8), align: 'center', lineBreak: false });
    const qr = await makeQr(`MW1:${c.token}`, { errorCorrectionLevel: 'M', margin: 4, width: 600 });
    const printed = new Intl.DateTimeFormat('en-GB',{timeZone:'Asia/Baghdad',day:'2-digit',month:'2-digit',year:'numeric',hour:'2-digit',minute:'2-digit',hourCycle:'h23'}).format(new Date(c.printed_at));
    const lines = [`Tour: ${c.tour_id}`, `Office: ${c.office}`, `Person: ${c.person_no}`, `Arrival: ${c.arrival}`, `Departure: ${c.departure}`];
    let x, y, textWidth, spacing;
    if (compact) {
      const qrMm = Math.min(35, heightMm - 16);
      doc.image(qr, mm(3), mm(12), { width: mm(qrMm), height: mm(qrMm) });
      x = mm(4 + qrMm); y = mm(14); textWidth = w - x - mm(4); spacing = mm(4.3);
      lines.push(`Printed: ${printed.slice(0, 10)}`, `${printed.slice(-5)} Karbala`);
      doc.fontSize(6.8);
    } else {
      const qrSize = Math.min(w - mm(12), h * .43);
      doc.image(qr, (w - qrSize) / 2, mm(20), { width: qrSize, height: qrSize });
      x = mm(5); y = mm(21) + qrSize; textWidth = w - mm(10); spacing = 11;
      lines.push(`Printed: ${printed} KRB`);
      doc.fontSize(8);
    }
    doc.fillColor('#111').font('Helvetica');
    lines.forEach((line, i) => doc.text(line, x, y + i * spacing, { width: textWidth, height: spacing, ellipsis: true, lineBreak: false }));
  }
}
