/* Shared by the admin panel and the proforma web page: document texts and the
   Excel export, so the client's download is the same file the admin sends. */
(function () {
  "use strict";

  var DOC = {
    en: { title: "PROFORMA INVOICE", no: "No.", date: "Date", valid: "Valid until", billTo: "Bill to", taxId: "Tax ID", phone: "Phone",
      email: "E-mail", web: "Website", item: "#", code: "Code", ref: "Your ref.", description: "Description", qty: "Qty", unit: "Unit price", amount: "Amount",
      total: "TOTAL", bank: "Bank details", beneficiary: "Beneficiary", bankName: "Bank", account: "Account No.", swift: "SWIFT / BIC",
      bankAddress: "Bank address", terms: "Terms & notes", page: "Page", currency: "Currency", photos: "Click here to view the photos in full size" },
    pt: { title: "FATURA PROFORMA", no: "Nº", date: "Data", valid: "Válida até", billTo: "Cliente", taxId: "Tax ID", phone: "Telefone",
      email: "E-mail", web: "Site", item: "#", code: "Código", ref: "Sua ref.", description: "Descrição", qty: "Qtd.", unit: "Preço unit.", amount: "Valor",
      total: "TOTAL", bank: "Dados bancários", beneficiary: "Beneficiário", bankName: "Banco", account: "Conta", swift: "SWIFT / BIC",
      bankAddress: "Endereço do banco", terms: "Condições e observações", page: "Página", currency: "Moeda", photos: "Clique aqui para visualizar as fotos em tamanho real" },
    es: { title: "FACTURA PROFORMA", no: "Nº", date: "Fecha", valid: "Válida hasta", billTo: "Cliente", taxId: "Tax ID", phone: "Teléfono",
      email: "Correo", web: "Sitio web", item: "#", code: "Código", ref: "Su ref.", description: "Descripción", qty: "Cant.", unit: "Precio unit.", amount: "Importe",
      total: "TOTAL", bank: "Datos bancarios", beneficiary: "Beneficiario", bankName: "Banco", account: "Cuenta", swift: "SWIFT / BIC",
      bankAddress: "Dirección del banco", terms: "Condiciones y observaciones", page: "Página", currency: "Moneda", photos: "Haga clic aquí para ver las fotos en tamaño real" }
  };

  function loadScript(src) {
    return new Promise(function (resolve, reject) {
      if (document.querySelector('script[src="' + src + '"]')) return resolve();
      var s = document.createElement("script");
      s.src = src;
      s.onload = resolve;
      s.onerror = function () { reject(new Error("Could not load " + src)); };
      document.head.appendChild(s);
    });
  }

  function fmt(n, d) {
    return Number(n).toLocaleString(d.lang === "en" ? "en-US" : d.lang === "pt" ? "pt-BR" : "es-ES", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  }
  function docDate(iso, d) {
    if (!iso) return "";
    return new Date(iso + "T00:00:00").toLocaleDateString(d.lang === "en" ? "en-GB" : d.lang === "pt" ? "pt-BR" : "es-ES");
  }
  function fileName(p, ext) {
    return (p.number + (p.client ? " - " + p.client.name : "")).replace(/[\\/:*?"<>|]+/g, " ").trim() + "." + ext;
  }

  // Builds and downloads the Excel file of a proforma. d: { lang, L (DOC texts),
  // settings (company and, for the admin, bank details), cur { label, symbol },
  // items [{ n, code, ref, name, description, options [text], qty, price, amount }],
  // total, p { number, date, validUntil, client, terms }, link }.
  function buildXlsx(d) {
    return loadScript("assets/vendor/exceljs.min.js").then(function () {
      var L = d.L, s = d.settings || {}, client = d.p.client || {};
      var wb = new window.ExcelJS.Workbook();
      wb.creator = s.companyName || "Micheng";
      var ws = wb.addWorksheet(d.p.number, { pageSetup: { paperSize: 9, orientation: "portrait", fitToPage: true, fitToWidth: 1, fitToHeight: 0 } });
      // Columns: #, code, [client's ref], description, qty, unit price, amount.
      var hasRef = d.items.some(function (it) { return it.ref; });
      var C = hasRef ? { ref: 3, desc: 4, qty: 5, unit: 6, amt: 7, last: 7 } : { desc: 3, qty: 4, unit: 5, amt: 6, last: 6 };
      var col = function (n) { return String.fromCharCode(64 + n); };
      ws.columns = [{ width: 6 }, { width: 12 }].concat(hasRef ? [{ width: 14 }] : []).concat([{ width: hasRef ? 56 : 66 }, { width: 10 }, { width: 16 }, { width: 18 }]);
      var navy = "FF0B2A4F";
      var moneyFmt = '"' + d.cur.symbol + '" #,##0.00';

      ws.mergeCells("A1:C1");
      ws.getCell("A1").value = s.companyName || "Shenzhen Micheng International Trading Co., Ltd.";
      ws.getCell("A1").font = { bold: true, size: 13, color: { argb: navy } };
      ws.mergeCells("D1:" + col(C.last) + "1");
      ws.getCell("D1").value = L.title;
      ws.getCell("D1").font = { bold: true, size: 15, color: { argb: navy } };
      ws.getCell("D1").alignment = { horizontal: "right" };

      var left = [];
      if (s.address) left.push(s.address.replace(/\n/g, ", "));
      if (s.phone) left.push(L.phone + ": " + s.phone);
      if (s.email) left.push(L.email + ": " + s.email);
      if (s.website) left.push(L.web + ": " + s.website);
      var right = [L.no + " " + d.p.number, L.date + ": " + docDate(d.p.date, d)];
      if (d.p.validUntil) right.push(L.valid + ": " + docDate(d.p.validUntil, d));
      right.push(L.currency + ": " + d.cur.label);
      var rowsN = Math.max(left.length, right.length);
      for (var i = 0; i < rowsN; i++) {
        var r = ws.getRow(2 + i);
        ws.mergeCells(2 + i, 1, 2 + i, 3);
        ws.mergeCells(2 + i, 4, 2 + i, C.last);
        r.getCell(1).value = left[i] || "";
        r.getCell(4).value = right[i] || "";
        r.getCell(4).alignment = { horizontal: "right" };
        r.font = { size: 9, color: { argb: "FF5B6878" } };
      }
      var y = 3 + rowsN;
      if (d.link) {
        ws.mergeCells(y, 1, y, C.last);
        ws.getCell(y, 1).value = { text: "\u2192 " + L.photos, hyperlink: d.link };
        ws.getCell(y, 1).font = { bold: true, underline: true, color: { argb: "FF1A6FD8" } };
        y += 2;
      }

      ws.getCell(y, 1).value = L.billTo.toUpperCase();
      ws.getCell(y, 1).font = { bold: true, size: 9, color: { argb: "FF5B6878" } };
      var bill = [client.name || ""];
      if (client.address) bill.push(client.address.replace(/\n/g, ", "));
      if (client.phone) bill.push(L.phone + ": " + client.phone);
      if (client.taxId) bill.push(L.taxId + ": " + client.taxId);
      bill.forEach(function (line, n) {
        ws.mergeCells(y + 1 + n, 1, y + 1 + n, C.last);
        var c = ws.getCell(y + 1 + n, 1);
        c.value = line;
        c.font = n === 0 ? { bold: true, size: 11 } : { size: 10 };
      });
      y += bill.length + 2;

      var head = ws.getRow(y);
      head.values = [L.item, L.code].concat(hasRef ? [L.ref] : []).concat([L.description, L.qty, L.unit + " (" + d.cur.label + ")", L.amount + " (" + d.cur.label + ")"]);
      head.eachCell(function (c) {
        c.font = { bold: true, color: { argb: "FFFFFFFF" } };
        c.fill = { type: "pattern", pattern: "solid", fgColor: { argb: navy } };
        c.alignment = { horizontal: "center", vertical: "middle", wrapText: true };
      });
      var first = y + 1;
      d.items.forEach(function (it, n) {
        var r = ws.getRow(first + n);
        r.getCell(1).value = it.n;
        r.getCell(2).value = it.code;
        if (hasRef) { r.getCell(C.ref).value = it.ref; r.getCell(C.ref).alignment = { horizontal: "center", vertical: "top" }; }
        r.getCell(C.desc).value = { richText: [{ text: it.name, font: { bold: true, size: 10 } }]
          .concat(it.description ? [{ text: "\n" + it.description, font: { size: 9, color: { argb: "FF546070" } } }] : [])
          .concat(it.options.length ? [{ text: "\n" + it.options.join("\n"), font: { size: 9, color: { argb: "FF546070" } } }] : []) };
        r.getCell(C.qty).value = it.qty;
        r.getCell(C.unit).value = it.price;
        r.getCell(C.amt).value = { formula: col(C.qty) + (first + n) + "*" + col(C.unit) + (first + n), result: it.amount };
        r.getCell(1).alignment = { horizontal: "center", vertical: "top" };
        r.getCell(2).alignment = { horizontal: "center", vertical: "top" };
        r.getCell(2).font = { bold: true };
        r.getCell(C.desc).alignment = { wrapText: true, vertical: "top" };
        [C.qty, C.unit, C.amt].forEach(function (k) { r.getCell(k).alignment = { vertical: "top" }; });
        r.getCell(C.unit).numFmt = moneyFmt;
        r.getCell(C.amt).numFmt = moneyFmt;
        // Wrapped text does not grow the row by itself: estimate the lines.
        var perLine = hasRef ? 62 : 74;
        var textLines = Math.ceil(it.name.length / perLine) + (it.description ? Math.ceil(it.description.length / (perLine * 1.1)) : 0) + it.options.length;
        r.height = Math.max(18, 14 * textLines);
      });
      var last = first + d.items.length - 1;
      var totalRow = last + 1;
      ws.getCell(totalRow, C.unit).value = L.total;
      ws.getCell(totalRow, C.unit).font = { bold: true, color: { argb: "FFFFFFFF" } };
      ws.getCell(totalRow, C.amt).value = { formula: "SUM(" + col(C.amt) + first + ":" + col(C.amt) + last + ")", result: d.total };
      ws.getCell(totalRow, C.amt).numFmt = moneyFmt;
      ws.getCell(totalRow, C.amt).font = { bold: true, color: { argb: "FFFFFFFF" } };
      [C.unit, C.amt].forEach(function (k) {
        ws.getCell(totalRow, k).fill = { type: "pattern", pattern: "solid", fgColor: { argb: navy } };
        ws.getCell(totalRow, k).alignment = { horizontal: "right" };
      });
      for (var rr = y; rr <= last; rr++) {
        for (var cc = 1; cc <= C.last; cc++) {
          ws.getCell(rr, cc).border = { top: { style: "thin", color: { argb: "FFDCE2EA" } }, bottom: { style: "thin", color: { argb: "FFDCE2EA" } },
            left: { style: "thin", color: { argb: "FFDCE2EA" } }, right: { style: "thin", color: { argb: "FFDCE2EA" } } };
        }
      }
      y = totalRow + 2;

      function section(title, lines) {
        if (!lines.length) return;
        ws.getCell(y, 1).value = title;
        ws.getCell(y, 1).font = { bold: true, color: { argb: navy } };
        lines.forEach(function (line, n) {
          ws.mergeCells(y + 1 + n, 1, y + 1 + n, C.last);
          ws.getCell(y + 1 + n, 1).value = line;
        });
        y += lines.length + 2;
      }
      section(L.terms, d.p.terms ? d.p.terms.split("\n") : []);
      var bank = [];
      if (s.bankBeneficiary) bank.push(L.beneficiary + ": " + s.bankBeneficiary);
      if (s.bankName) bank.push(L.bankName + ": " + s.bankName);
      if (s.bankAccount) bank.push(L.account + ": " + s.bankAccount);
      if (s.bankSwift) bank.push(L.swift + ": " + s.bankSwift);
      if (s.bankAddress) bank.push(L.bankAddress + ": " + s.bankAddress.replace(/\n/g, ", "));
      if (s.bankNotes) bank = bank.concat(s.bankNotes.split("\n"));
      section(L.bank, bank);

      return wb.xlsx.writeBuffer().then(function (buf) {
        var blob = new Blob([buf], { type: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" });
        var a = document.createElement("a");
        a.href = URL.createObjectURL(blob);
        a.download = fileName(d.p, "xlsx");
        document.body.appendChild(a);
        a.click();
        setTimeout(function () { URL.revokeObjectURL(a.href); a.remove(); }, 1000);
      });
    });
  }

  window.ProformaDoc = { DOC: DOC, loadScript: loadScript, fmt: fmt, docDate: docDate, fileName: fileName, buildXlsx: buildXlsx };
})();
