import React, { useState, useCallback, useEffect, useMemo } from 'react';
import { useDropzone } from 'react-dropzone';
import { GoogleGenAI } from '@google/genai';
import { UploadCloud, FileDown, FileText, Table as TableIcon, Loader2, AlertCircle, CheckCircle, X, Search, Filter } from 'lucide-react';
import jsPDF from 'jspdf';
import autoTable from 'jspdf-autotable';
import * as XLSX from 'xlsx';
import { PDFDocument, rgb } from 'pdf-lib';
import { db, storage, auth } from './firebase';
import { collection, doc, addDoc, updateDoc, onSnapshot, query, orderBy, deleteDoc, getDocs, where } from 'firebase/firestore';
import { ref, uploadBytes, getDownloadURL } from 'firebase/storage';
import { GoogleAuthProvider, signInWithRedirect, getRedirectResult, signOut, User } from 'firebase/auth';
import type { FirestoreInvoice, UploadState } from './types';

const GEMINI_API_KEY = process.env.GEMINI_API_KEY || '';
if (!GEMINI_API_KEY) {
  console.error('GEMINI_API_KEY is not set. OCR processing will fail.');
}
const ai = new GoogleGenAI({ apiKey: GEMINI_API_KEY });

const isEmployeePaid = (method: string) => ['Employee Personal Account', 'Employee Cash', 'Employee Personal Card'].includes(method);

export default function App() {
  const [user, setUser] = useState<User | null>(null);
  const [invoices, setInvoices] = useState<FirestoreInvoice[]>([]);
  const [activeTab, setActiveTab] = useState<'batch' | 'claims' | 'history'>('batch');
  
  const [uploadTracker, setUploadTracker] = useState<UploadState[]>([]);
  const [duplicateConflicts, setDuplicateConflicts] = useState<{
    newInvoice: Partial<FirestoreInvoice>;
    ocrRawData: any;
    existingInvoice: FirestoreInvoice;
    docId: string;
  }[]>([]);

  // Modals state
  const [editingInvoiceId, setEditingInvoiceId] = useState<string | null>(null);
  const [viewingInvoiceId, setViewingInvoiceId] = useState<string | null>(null);
  const [previewImage, setPreviewImage] = useState<string | null>(null);

  // Filters State
  const [searchQuery, setSearchQuery] = useState('');
  const [filterStartDate, setFilterStartDate] = useState('');
  const [filterEndDate, setFilterEndDate] = useState('');
  const [filterPaidBy, setFilterPaidBy] = useState('');
  const [filterStatus, setFilterStatus] = useState('');
  const [filterIsDuplicate, setFilterIsDuplicate] = useState<boolean | ''>('');
  
  const [toasts, setToasts] = useState<{ id: string, message: string, type: 'info' | 'success' | 'error' | 'warning' }[]>([]);

  const addToast = (message: string, type: 'info' | 'success' | 'error' | 'warning' = 'info') => {
    const id = Math.random().toString(36).substr(2, 9);
    setToasts(prev => [...prev, { id, message, type }]);
    setTimeout(() => {
      setToasts(prev => prev.filter(t => t.id !== id));
    }, 5000);
  };

  // Session markers
  const [sessionStartTime] = useState(Date.now());

  useEffect(() => {
    getRedirectResult(auth).catch(() => {});
    const unsubAuth = auth.onAuthStateChanged(u => setUser(u));
    const q = query(collection(db, 'invoices'), orderBy('uploadedAt', 'desc'));
    const unsub = onSnapshot(q, (snap) => {
      const data: FirestoreInvoice[] = [];
      snap.forEach(d => {
        data.push({ id: d.id, ...d.data() } as FirestoreInvoice);
      });
      setInvoices(data);
    }, (err) => {
      console.error("Firestore error:", err);
    });
    return () => {
      unsubAuth();
      unsub();
    };
  }, []);

  const updateTracker = (id: string, updates: Partial<UploadState>) => {
    setUploadTracker(prev => prev.map(t => t.id === id ? { ...t, ...updates } : t));
  };

  const onDrop = useCallback(async (acceptedFiles: File[]) => {
    if (acceptedFiles.length === 0) return;

    if (!auth.currentUser) {
      addToast('Please sign in to upload files.', 'warning');
      return;
    }

    const initialTrackers: UploadState[] = acceptedFiles.map(f => ({
      id: `temp_${Date.now()}_${Math.floor(Math.random() * 1000)}`,
      fileName: f.name,
      status: 'Uploading',
      progress: 0
    }));
    
    setUploadTracker(prev => [...prev, ...initialTrackers]);

    for (let i = 0; i < acceptedFiles.length; i++) {
       await handleFileUpload(acceptedFiles[i], initialTrackers[i].id);
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const handleFileUpload = async (file: File, trackerId: string) => {
    const now = Date.now();
    let fileUrl = '';
    
    try {
      // 1. Upload to storage
      updateTracker(trackerId, { status: 'Uploading', progress: 10 });
      const storageRef = ref(storage, `invoice-files/${now}_${file.name}`);
      await uploadBytes(storageRef, file);
      fileUrl = await getDownloadURL(storageRef);

      updateTracker(trackerId, { status: 'Processing OCR', progress: 40 });

      // 2. Process via AI
      const base64Promise = new Promise<string>((resolve, reject) => {
        const reader = new FileReader();
        reader.onloadend = () => resolve((reader.result as string).split(',')[1]);
        reader.onerror = reject;
        reader.readAsDataURL(file);
      });
      const base64Data = await base64Promise;

      const promptText = `You are an expert AI accounting assistant specialized in invoice OCR, data extraction, validation, and structured financial analysis.
Return the output in the EXACT following JSON structure:
{
  "json_data": {
    "invoice_information": { "invoice_number": "", "invoice_date": "", "due_date": "", "currency": "" },
    "supplier_information": { "supplier_name": "", "vat_number": "" },
    "customer_information": { "customer_name": "" },
    "line_items": [ { "description": "", "quantity": "", "unit_price": "", "tax": "", "total": "" } ],
    "financial_summary": { "subtotal": "", "vat": "", "grand_total": "" }
  }
}
Rules:
1. Do not hallucinate missing data.
2. Output MUST be valid JSON only.
3. IMPORTANT: Extract the Supplier VAT Number/TRN into "vat_number".`;

      const response = await ai!.models.generateContent({
        model: 'gemini-3.1-pro-preview',
        contents: { parts: [{ inlineData: { mimeType: file.type || 'image/jpeg', data: base64Data } }, { text: promptText }] },
        config: { responseMimeType: 'application/json', temperature: 0.1 },
      });

      const text = response.text;
      if (!text) throw new Error("No response returned from model");
      
      const parsed = JSON.parse(text);
      const data = parsed.json_data || {};
      
      updateTracker(trackerId, { status: 'Duplicate Check', progress: 80 });

      const newInvData: Partial<FirestoreInvoice> = {
         fileName: file.name,
         fileUrl,
         uploadedAt: now,
         processedAt: Date.now(),
         processingStatus: 'Success',
         invoiceNumber: data.invoice_information?.invoice_number || '',
         invoiceDate: data.invoice_information?.invoice_date || '',
         supplierName: data.supplier_information?.supplier_name || '',
         supplierVatNumber: data.supplier_information?.vat_number || '',
         customerName: data.customer_information?.customer_name || '',
         currency: data.invoice_information?.currency || '',
         subtotal: data.financial_summary?.subtotal || 0,
         vatAmount: data.financial_summary?.vat || 0,
         grandTotal: data.financial_summary?.grand_total || 0,
         expenseCategory: 'General',
         paidBy: 'Company Account',
         employeeName: '',
         employeeId: '',
         department: '',
         claimStatus: 'Draft',
         approvalStatus: 'Pending',
         validationStatus: 'Pending',
         notes: '',
         lineItems: data.line_items || [],
         updatedAt: Date.now()
      };

      // 3. Duplicate check
      // Query Firestore where invoiceNumber, supplier, total match
      let isDuplicate = false;
      let existingInv = null;
      if (newInvData.invoiceNumber && newInvData.supplierName) {
        const qDup = query(collection(db, 'invoices'), 
          where('invoiceNumber', '==', newInvData.invoiceNumber),
          where('supplierName', '==', newInvData.supplierName),
          where('grandTotal', '==', newInvData.grandTotal)
        );
        const dupSnap = await getDocs(qDup);
        if (!dupSnap.empty) {
          isDuplicate = true;
          existingInv = { id: dupSnap.docs[0].id, ...dupSnap.docs[0].data() } as FirestoreInvoice;
        }
      }

      if (isDuplicate && existingInv) {
        setDuplicateConflicts(prev => [...prev, {
          newInvoice: newInvData,
          ocrRawData: parsed,
          existingInvoice: existingInv,
          docId: trackerId // Using trackerId to link it back later if needed
        }]);
        updateTracker(trackerId, { status: 'Duplicate Check', progress: 100 });
        addToast(`Duplicate detected for ${file.name}`, 'warning');
      } else {
        // Safe to save
        await addDoc(collection(db, 'invoices'), { ...newInvData, ocrRawData: parsed });
        updateTracker(trackerId, { status: 'Completed', progress: 100 });
        addToast(`Successfully processed ${file.name}`, 'success');
      }

    } catch (err: any) {
      console.error(err);
      let errorMessage = err.message || 'Error processing invoice';
      if (errorMessage.includes('429') || errorMessage.includes('quota') || errorMessage.includes('RESOURCE_EXHAUSTED')) {
         errorMessage = 'API Quota Exceeded.';
      }
      updateTracker(trackerId, { status: 'Failed', progress: 100 });
      addToast(`Failed to process ${file.name}: ${errorMessage}`, 'error');
    }
  };

  const { getRootProps, getInputProps, isDragActive } = useDropzone({
    onDrop, accept: { 'image/*': ['.png', '.jpg', '.jpeg', '.webp', '.pdf'] }, multiple: true
  } as any);

  const handleDelete = async (id: string) => {
    try {
      await deleteDoc(doc(db, 'invoices', id));
      addToast('Invoice deleted.', 'info');
    } catch (e) {
      console.error('Delete failed:', e);
      addToast('Failed to delete invoice.', 'error');
    }
  };

  // Derived filtered views
  const filteredInvoices = useMemo(() => {
    let list = invoices;
    
    // Base Tab Filters
    if (activeTab === 'batch') {
      list = list.filter(i => !isEmployeePaid(i.paidBy) && i.uploadedAt >= sessionStartTime);
    } else if (activeTab === 'claims') {
      list = list.filter(i => isEmployeePaid(i.paidBy) && i.uploadedAt >= sessionStartTime);
    } // else History => all

    // Search Filter
    if (searchQuery) {
      const q = searchQuery.toLowerCase();
      list = list.filter(i => 
        i.invoiceNumber.toLowerCase().includes(q) ||
        i.supplierName.toLowerCase().includes(q) ||
        i.supplierVatNumber.toLowerCase().includes(q) ||
        i.fileName.toLowerCase().includes(q)
      );
    }
    
    if (filterStatus) {
      list = list.filter(i => i.processingStatus === filterStatus);
    }
    if (filterPaidBy) {
      list = list.filter(i => i.paidBy === filterPaidBy);
    }
    if (filterIsDuplicate !== '') {
      list = list.filter(i => (i.isDuplicate || false) === filterIsDuplicate);
    }
    
    if (filterStartDate) {
      const ts = new Date(filterStartDate).getTime();
      list = list.filter(i => {
         const invDate = new Date(i.invoiceDate).getTime();
         return !isNaN(invDate) ? invDate >= ts : i.uploadedAt >= ts;
      });
    }
    if (filterEndDate) {
      const ts = new Date(filterEndDate).getTime() + 86400000;
      list = list.filter(i => {
         const invDate = new Date(i.invoiceDate).getTime();
         return !isNaN(invDate) ? invDate <= ts : i.uploadedAt <= ts;
      });
    }

    return list;
  }, [invoices, activeTab, sessionStartTime, searchQuery, filterStatus, filterPaidBy, filterStartDate, filterEndDate, filterIsDuplicate]);

  const generateExcel = () => {
    if (filteredInvoices.length === 0) { addToast('No items to export.', 'warning'); return; }
    const wb = XLSX.utils.book_new();
    const rows = filteredInvoices.map(inv => ({
      "Date": new Date(inv.uploadedAt).toLocaleDateString(),
      "File Name": inv.fileName,
      "Status": inv.processingStatus,
      "Invoice No.": inv.invoiceNumber,
      "Date Invoiced": inv.invoiceDate,
      "Supplier": inv.supplierName,
      "Supplier VAT": inv.supplierVatNumber,
      "Currency": inv.currency,
      "Grand Total": inv.claimAmountOverride || inv.grandTotal,
      "Category": inv.expenseCategory,
      "Paid By": inv.paidBy,
      "Employee": inv.employeeName,
      "Claim Status": inv.claimStatus
    }));
    const ws = XLSX.utils.json_to_sheet(rows);
    XLSX.utils.book_append_sheet(wb, ws, "Invoices");
    XLSX.writeFile(wb, "Invoice_Export.xlsx");
  };

  const isProcessingBatch = uploadTracker.length > 0 && uploadTracker.some(t => ['Uploading', 'Processing OCR', 'Duplicate Check'].includes(t.status));

  const clearFilters = () => {
    setSearchQuery('');
    setFilterStartDate('');
    setFilterEndDate('');
    setFilterPaidBy('');
    setFilterStatus('');
    setFilterIsDuplicate('');
  };

  const handleResolveDuplicate = async (docId: string, action: 'skip' | 'save') => {
    const conflict = duplicateConflicts.find(c => c.docId === docId);
    if (!conflict) return;

    setDuplicateConflicts(prev => prev.filter(c => c.docId !== docId));

    if (action === 'save') {
       try {
         await addDoc(collection(db, 'invoices'), { 
            ...conflict.newInvoice, 
            ocrRawData: conflict.ocrRawData,
            isDuplicate: true,
            duplicateOf: conflict.existingInvoice.id 
         });
         updateTracker(docId, { status: 'Completed', progress: 100 });
         addToast(`Force saved duplicate invoice ${conflict.newInvoice.fileName}`, 'info');
       } catch (e) {
         updateTracker(docId, { status: 'Failed', progress: 100 });
         addToast(`Failed to save duplicate invoice`, 'error');
       }
    } else {
       updateTracker(docId, { status: 'Skipped', progress: 100 });
       addToast(`Skipped duplicate invoice ${conflict.newInvoice.fileName}`, 'info');
    }
  };

  const [isExportingPDF, setIsExportingPDF] = useState(false);

  const buildSummaryTable = (pdfDoc: jsPDF) => {
    pdfDoc.text("Consolidated Invoice Report", 14, 15);
    const successCount = filteredInvoices.filter(i => i.processingStatus === 'Success').length;
    const failedCount  = filteredInvoices.filter(i => i.processingStatus === 'Failed').length;
    const dupCount     = filteredInvoices.filter(i => i.isDuplicate).length;
    pdfDoc.setFontSize(10);
    pdfDoc.text(`Export Date: ${new Date().toLocaleDateString()} | Total: ${filteredInvoices.length}`, 14, 22);
    pdfDoc.text(`Processed: ${successCount}  |  Failed: ${failedCount}  |  Duplicates: ${dupCount}`, 14, 27);
    autoTable(pdfDoc, {
      head: [["#","File Name","Status","Invoice No.","Date","Supplier","VAT No.","Currency","Subtotal","VAT","Total","Paid By","Claim","Dup","Notes"]],
      body: filteredInvoices.map((inv, i) => [
        (i + 1).toString(),
        (inv.fileName || '').substring(0, 20),
        inv.processingStatus,
        inv.invoiceNumber || '-',
        inv.invoiceDate || '-',
        (inv.supplierName || '').substring(0, 20),
        inv.supplierVatNumber || '-',
        inv.currency || '-',
        inv.subtotal || '-',
        inv.vatAmount || '-',
        inv.grandTotal || '-',
        inv.paidBy || '-',
        inv.claimStatus || '-',
        inv.isDuplicate ? 'Yes' : 'No',
        (inv.notes || '').substring(0, 15)
      ]),
      startY: 32,
      styles: { fontSize: 7, cellPadding: 1, overflow: 'linebreak' },
      headStyles: { fillColor: [79, 70, 229] },
      showHead: 'everyPage'
    });
  };

  const toProxyUrl = (url: string): string =>
    import.meta.env.DEV
      ? url.replace('https://firebasestorage.googleapis.com', '/storage-proxy')
      : url;

  const downloadFileWithTimeout = async (fileUrl: string, timeoutMs = 10000): Promise<ArrayBuffer | null> => {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const resp = await fetch(toProxyUrl(fileUrl), { signal: controller.signal });
      clearTimeout(timer);
      return resp.ok ? await resp.arrayBuffer() : null;
    } catch {
      clearTimeout(timer);
      return null;
    }
  };

  const convertToJpeg = (blob: Blob): Promise<ArrayBuffer> =>
    new Promise((resolve, reject) => {
      const img = new Image();
      const url = URL.createObjectURL(blob);
      img.onload = () => {
        try {
          const canvas = document.createElement('canvas');
          canvas.width = img.width;
          canvas.height = img.height;
          const ctx = canvas.getContext('2d');
          if (!ctx) { reject(new Error('No canvas context')); return; }
          ctx.fillStyle = 'white';
          ctx.fillRect(0, 0, canvas.width, canvas.height);
          ctx.drawImage(img, 0, 0);
          canvas.toBlob(resBlob => {
            URL.revokeObjectURL(url);
            if (resBlob) resBlob.arrayBuffer().then(resolve).catch(reject);
            else reject(new Error('Canvas toBlob failed'));
          }, 'image/jpeg', 0.92);
        } catch (e) { URL.revokeObjectURL(url); reject(e); }
      };
      img.onerror = () => { URL.revokeObjectURL(url); reject(new Error('Image load failed')); };
      img.src = url;
    });

  const triggerDownload = (bytes: Uint8Array, filename: string) => {
    const blob = new Blob([bytes], { type: 'application/pdf' });
    const url  = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = url;
    link.download = filename;
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);
    URL.revokeObjectURL(url);
  };

  const generatePDF = async (withAttachments: boolean) => {
    if (filteredInvoices.length === 0) { addToast('No items to export.', 'warning'); return; }
    setIsExportingPDF(true);
    addToast(withAttachments ? `Downloading ${filteredInvoices.length} attachments in parallel…` : 'Building summary PDF…', 'info');

    try {
      const jsPdfDoc = new jsPDF('landscape');
      buildSummaryTable(jsPdfDoc);
      const finalPdf = await PDFDocument.load(jsPdfDoc.output('arraybuffer'));

      if (withAttachments) {
        // Download all files in parallel with individual timeouts
        const results = await Promise.allSettled(
          filteredInvoices.map(inv => inv.fileUrl ? downloadFileWithTimeout(inv.fileUrl) : Promise.resolve(null))
        );

        let attached = 0, failed = 0;
        for (let i = 0; i < filteredInvoices.length; i++) {
          const inv = filteredInvoices[i];
          const settled = results[i];
          const arrayBuffer = settled.status === 'fulfilled' ? settled.value : null;

          const headerPage = finalPdf.addPage([595.28, 841.89]);
          headerPage.drawText('Original Invoice Attachment', { x: 50, y: 800, size: 16 });
          headerPage.drawText(`File: ${inv.fileName}`,            { x: 50, y: 760, size: 11 });
          headerPage.drawText(`Invoice No: ${inv.invoiceNumber || '-'}`, { x: 50, y: 742, size: 11 });
          headerPage.drawText(`Supplier: ${inv.supplierName || '-'}`,    { x: 50, y: 724, size: 11 });
          headerPage.drawText(`Total: ${inv.currency || ''} ${inv.grandTotal || '-'}`, { x: 50, y: 706, size: 11 });
          headerPage.drawText(`Status: ${inv.isDuplicate ? 'Duplicate' : inv.processingStatus}`, { x: 50, y: 688, size: 11 });

          if (!arrayBuffer) {
            headerPage.drawText('[Attachment unavailable — configure Firebase Storage CORS to enable]', { x: 50, y: 650, size: 9, color: rgb(0.6, 0.3, 0) });
            failed++;
            continue;
          }

          try {
            const ext = inv.fileName.toLowerCase().split('.').pop() || '';
            if (ext === 'pdf') {
              const attachPdf = await PDFDocument.load(arrayBuffer);
              const pages = await finalPdf.copyPages(attachPdf, attachPdf.getPageIndices());
              pages.forEach(p => finalPdf.addPage(p));
            } else {
              const jpgBuf = await convertToJpeg(new Blob([arrayBuffer]));
              const image  = await finalPdf.embedJpg(jpgBuf);
              const { width, height } = image.scale(1);
              const maxW = 495, maxH = 600;
              let scale = Math.min(maxW / width, maxH / height, 1);
              headerPage.drawImage(image, {
                x: 50 + (maxW - width * scale) / 2,
                y: 670 - height * scale,
                width: width * scale,
                height: height * scale,
              });
            }
            attached++;
          } catch (e: any) {
            headerPage.drawText(`[Embed error: ${e.message}]`, { x: 50, y: 650, size: 9, color: rgb(0.8, 0, 0) });
            failed++;
          }
        }

        addToast(`PDF ready — ${attached} attached, ${failed} unavailable.`, failed > 0 ? 'warning' : 'success');
      } else {
        addToast('Summary PDF ready!', 'success');
      }

      triggerDownload(await finalPdf.save(), withAttachments ? 'invoice_report_full.pdf' : 'invoice_report_summary.pdf');
    } catch (err) {
      console.error(err);
      addToast('Error generating PDF.', 'error');
    } finally {
      setIsExportingPDF(false);
    }
  };

  return (
    <div className="h-screen w-full bg-slate-50 flex flex-col font-sans overflow-hidden text-slate-900">
      <header className="h-16 bg-white border-b border-slate-200 flex items-center justify-between px-4 sm:px-8 shrink-0 relative z-10">
        <div className="flex items-center gap-3">
          <div className="w-8 h-8 bg-indigo-600 rounded flex items-center justify-center text-white font-bold">Σ</div>
          <h1 className="text-lg font-bold text-slate-800 tracking-tight hidden sm:block">AccounTech AI <span className="text-slate-400 font-normal">| Connected</span></h1>
          <h1 className="text-lg font-bold text-slate-800 tracking-tight sm:hidden">AccounTech</h1>
        </div>
        <div className="flex items-center gap-4">
          <nav className="hidden md:flex bg-slate-100 p-1 rounded-lg">
            <button onClick={() => setActiveTab('batch')} className={`px-4 py-1.5 text-xs font-bold rounded-md ${activeTab === 'batch' ? 'bg-white shadow-sm' : 'text-slate-500'}`}>Current Batch</button>
            <button onClick={() => setActiveTab('claims')} className={`px-4 py-1.5 text-xs font-bold rounded-md ${activeTab === 'claims' ? 'bg-white shadow-sm' : 'text-slate-500'}`}>Current Claims</button>
            <button onClick={() => setActiveTab('history')} className={`px-4 py-1.5 text-xs font-bold rounded-md ${activeTab === 'history' ? 'bg-white shadow-sm text-indigo-600' : 'text-slate-500'}`}>History</button>
          </nav>
          {user ? (
            <div className="flex items-center gap-3">
              <span className="text-xs font-medium text-slate-600 hidden sm:block">{user.email}</span>
              <button onClick={() => signOut(auth)} className="text-xs px-3 py-1.5 bg-slate-100 text-slate-600 rounded font-semibold hover:bg-slate-200">Sign Out</button>
            </div>
          ) : (
            <button onClick={() => signInWithRedirect(auth, new GoogleAuthProvider())} className="text-xs px-4 py-1.5 bg-indigo-600 justify-center text-white rounded-md font-semibold hover:bg-indigo-700 flex items-center gap-2">
              Sign In
            </button>
          )}
        </div>
      </header>

      <main className="flex-1 flex flex-col overflow-hidden relative z-0 p-4 sm:p-6 custom-scrollbar overflow-y-auto">
        <div className="max-w-7xl mx-auto w-full space-y-6">
          
          {/* Uploader Section - Only show in current batch/claims */}
          {(activeTab === 'batch' || activeTab === 'claims') && (
            <div className="bg-white p-6 rounded-xl border border-slate-200 shadow-sm flex flex-col gap-6">
                <div {...getRootProps()} className={`p-8 border-2 border-dashed rounded-xl cursor-pointer text-center ${isDragActive ? 'border-indigo-500 bg-indigo-50' : 'border-slate-300 hover:bg-slate-50'}`}>
                  <input {...getInputProps()} />
                  <UploadCloud className="w-8 h-8 mx-auto text-indigo-400 mb-2" />
                  <p className="text-sm font-medium text-slate-700">Drag & drop invoices here</p>
                  <p className="text-[10px] text-slate-500 mt-1 uppercase tracking-wider">Supports PDF & Images. Processed securely via Firebase.</p>
                </div>

                {/* Upload Tracker */}
                {uploadTracker.length > 0 && (
                  <div className="bg-slate-50 border border-slate-200 rounded-lg p-4">
                    <div className="flex flex-col gap-2 mb-4">
                       <div className="flex justify-between items-center">
                          <h3 className="font-bold text-sm text-slate-800">Upload Status</h3>
                          <div className="text-xs text-slate-500 flex gap-3">
                            <span>Total: {uploadTracker.length}</span>
                            <span>Completed: {uploadTracker.filter(t => t.status === 'Completed').length}</span>
                            <span>Failed/Skipped: {uploadTracker.filter(t => t.status === 'Failed' || t.status === 'Skipped').length}</span>
                            <span>Processing: {uploadTracker.filter(t => t.status === 'Uploading' || t.status === 'Processing OCR' || t.status === 'Duplicate Check').length}</span>
                          </div>
                       </div>
                       
                       {/* Overall Progress Bar */}
                       <div className="w-full bg-slate-200 rounded-full h-2 relative overflow-hidden flex">
                          {uploadTracker.length > 0 && (
                            <div 
                              className="bg-indigo-500 transition-all duration-300 h-full" 
                              style={{ width: `${Math.round(uploadTracker.reduce((acc,t)=>acc+t.progress, 0)/uploadTracker.length)}%` }}
                            ></div>
                          )}
                       </div>
                       
                       <div className="flex justify-between text-[10px] text-slate-400 font-medium">
                          <span>Overall Progress</span>
                          <span>{uploadTracker.length > 0 ? Math.round(uploadTracker.reduce((acc,t)=>acc+t.progress, 0)/uploadTracker.length) : 0}%</span>
                          {uploadTracker.filter(t => ['Completed', 'Failed', 'Skipped'].includes(t.status)).length === uploadTracker.length && (
                             <span className="text-emerald-600 font-bold ml-2">All files processed!</span>
                          )}
                       </div>
                    </div>
                    
                    <div className="space-y-2 max-h-48 overflow-y-auto pr-2 custom-scrollbar">
                       {uploadTracker.slice().reverse().map(t => (
                         <div key={t.id} className="flex items-center justify-between text-xs bg-white p-2 rounded border border-slate-100 shadow-sm">
                            <span className="font-medium text-slate-700 truncate w-1/3" title={t.fileName}>{t.fileName}</span>
                            <div className="w-1/3 px-4 flex items-center">
                               <div className="w-full bg-slate-200 rounded-full h-1.5">
                                  <div className={`h-1.5 rounded-full ${t.status === 'Failed' ? 'bg-red-500' : t.status === 'Skipped' ? 'bg-amber-500' : 'bg-indigo-500'}`} style={{ width: `${t.progress}%` }}></div>
                               </div>
                            </div>
                            <span className={`w-1/4 text-right font-semibold ${t.status === 'Failed' ? 'text-red-600' : t.status === 'Completed' ? 'text-emerald-600' : t.status === 'Skipped' ? 'text-amber-600' : 'text-indigo-600'}`}>
                               {t.status}{t.progress < 100 ? '...' : ''}
                            </span>
                         </div>
                       ))}
                    </div>
                  </div>
                )}
            </div>
          )}

          {/* Filters Bar */}
          <div className="bg-white p-4 rounded-xl border border-slate-200 shadow-sm flex flex-col gap-4">
             {/* Top Row: Search & Actions */}
             <div className="flex flex-col sm:flex-row justify-between items-center gap-4">
               <div className="relative w-full sm:max-w-md">
                  <Search className="w-5 h-5 absolute left-3 top-2.5 text-slate-400" />
                  <input type="text" placeholder="Search invoices, suppliers, VAT..." value={searchQuery} onChange={e=>setSearchQuery(e.target.value)} className="w-full pl-10 pr-3 py-2.5 text-sm bg-slate-50 border border-slate-200 rounded-lg focus:outline-none focus:ring-2 focus:ring-indigo-500 focus:bg-white transition-all text-slate-800 placeholder:text-slate-400" />
               </div>
               <div className="flex flex-wrap items-center gap-2 w-full sm:w-auto">
                 <button onClick={clearFilters} className="px-4 py-2 text-xs font-semibold text-slate-600 bg-slate-100 hover:bg-slate-200 rounded-lg transition-colors">Clear Filters</button>
                 <button onClick={generateExcel} disabled={isProcessingBatch} className={`flex items-center justify-center gap-2 px-4 py-2 text-xs font-semibold text-emerald-700 bg-emerald-50 hover:bg-emerald-100 rounded-lg border border-emerald-200 transition-colors ${isProcessingBatch ? 'opacity-50 cursor-not-allowed' : ''}`}>
                    <TableIcon className="w-4 h-4" /> Export Excel
                 </button>
                 <button onClick={() => generatePDF(false)} disabled={isExportingPDF || isProcessingBatch} className={`flex items-center justify-center gap-2 px-4 py-2 text-xs font-semibold text-rose-700 bg-rose-50 hover:bg-rose-100 rounded-lg border border-rose-200 transition-colors ${(isExportingPDF || isProcessingBatch) ? 'opacity-50 cursor-not-allowed' : ''}`}>
                    {isExportingPDF ? <Loader2 className="w-4 h-4 animate-spin" /> : <FileText className="w-4 h-4" />}
                    PDF Summary
                 </button>
                 <button onClick={() => generatePDF(true)} disabled={isExportingPDF || isProcessingBatch} className={`flex items-center justify-center gap-2 px-4 py-2 text-xs font-semibold text-violet-700 bg-violet-50 hover:bg-violet-100 rounded-lg border border-violet-200 transition-colors ${(isExportingPDF || isProcessingBatch) ? 'opacity-50 cursor-not-allowed' : ''}`}>
                    {isExportingPDF ? <Loader2 className="w-4 h-4 animate-spin" /> : <FileDown className="w-4 h-4" />}
                    PDF + Files
                 </button>
               </div>
             </div>
             
             {/* Bottom Row: Filters */}
             <div className="flex flex-wrap items-center gap-3 pt-4 border-t border-slate-100">
               <div className="flex items-center bg-slate-50 rounded-lg border border-slate-200 px-2 py-1 shadow-sm">
                 <span className="text-xs font-medium text-slate-400 mr-2 ml-1">Date:</span>
                 <input type="date" value={filterStartDate} onChange={e=>setFilterStartDate(e.target.value)} className="px-1 text-xs bg-transparent border-none focus:outline-none focus:ring-0 text-slate-600 cursor-pointer" title="Start Date" />
                 <span className="text-slate-300 mx-1">-</span>
                 <input type="date" value={filterEndDate} onChange={e=>setFilterEndDate(e.target.value)} className="px-1 text-xs bg-transparent border-none focus:outline-none focus:ring-0 text-slate-600 cursor-pointer" title="End Date" />
               </div>
               
               <div className="flex flex-wrap gap-2">
                 <select value={filterStatus} onChange={e=>setFilterStatus(e.target.value)} className="px-3 py-1.5 text-xs font-medium bg-slate-50 border border-slate-200 rounded-lg focus:outline-none focus:border-indigo-500 focus:ring-1 focus:ring-indigo-500 text-slate-600 cursor-pointer shadow-sm appearance-none">
                   <option value="">Status: All</option>
                   <option value="Processing">Processing</option>
                   <option value="Success">Success</option>
                   <option value="Failed">Failed</option>
                 </select>
                 
                 <select value={filterPaidBy} onChange={e=>setFilterPaidBy(e.target.value)} className="px-3 py-1.5 text-xs font-medium bg-slate-50 border border-slate-200 rounded-lg focus:outline-none focus:border-indigo-500 focus:ring-1 focus:ring-indigo-500 text-slate-600 cursor-pointer shadow-sm appearance-none">
                   <option value="">Payment: All</option>
                   <option value="Company Account">Company Account</option>
                   <option value="Employee Personal Account">Employee Account</option>
                 </select>
                 
                 <select value={filterIsDuplicate === '' ? '' : filterIsDuplicate ? 'true' : 'false'} onChange={e=>setFilterIsDuplicate(e.target.value === '' ? '' : e.target.value === 'true')} className="px-3 py-1.5 text-xs font-medium bg-slate-50 border border-slate-200 rounded-lg focus:outline-none focus:border-indigo-500 focus:ring-1 focus:ring-indigo-500 text-slate-600 cursor-pointer shadow-sm appearance-none">
                   <option value="">Type: All</option>
                   <option value="false">Originals Only</option>
                   <option value="true">Duplicates Only</option>
                 </select>
               </div>
             </div>
          </div>

          {/* Table */}
          <div className="bg-white rounded-xl border border-slate-200 shadow-sm overflow-hidden overflow-x-auto">
             <table className="w-full text-left border-collapse min-w-[1200px]">
                <thead>
                  <tr className="bg-slate-100 border-b border-slate-200">
                    <th className="px-4 py-3 text-[10px] font-bold text-slate-500 uppercase">File & Date</th>
                    <th className="px-4 py-3 text-[10px] font-bold text-slate-500 uppercase">Status</th>
                    <th className="px-4 py-3 text-[10px] font-bold text-slate-500 uppercase">Invoice No.</th>
                    <th className="px-4 py-3 text-[10px] font-bold text-slate-500 uppercase">Supplier</th>
                    <th className="px-4 py-3 text-[10px] font-bold text-slate-500 uppercase">VAT Number</th>
                    <th className="px-4 py-3 text-[10px] font-bold text-slate-500 uppercase">Paid By</th>
                    <th className="px-4 py-3 text-[10px] font-bold text-slate-500 uppercase text-right">Total</th>
                    <th className="px-4 py-3 text-[10px] font-bold text-slate-500 uppercase text-center w-32">Actions</th>
                  </tr>
                </thead>
                <tbody className="text-xs text-slate-700 divide-y divide-slate-100">
                  {filteredInvoices.map((inv) => (
                    <tr key={inv.id} className="hover:bg-slate-50 transition-colors">
                      <td className="px-4 py-3">
                         <div className="font-medium text-slate-900 truncate max-w-[150px]">
                            {inv.fileName}
                            {inv.isDuplicate && <span className="ml-2 inline-block px-1.5 py-0.5 bg-amber-100 text-amber-700 text-[9px] font-bold uppercase rounded">Duplicate</span>}
                         </div>
                         <div className="text-[10px] text-slate-500 mt-0.5">{new Date(inv.uploadedAt).toLocaleString()}</div>
                      </td>
                      <td className="px-4 py-3">
                         {inv.processingStatus === 'Processing' ? <span className="text-indigo-600 font-medium">Processing...</span> : 
                          inv.processingStatus === 'Failed' ? <span className="text-red-600 font-medium pb-1 border-b border-dashed border-red-300" title={inv.error || 'Failed to process'}>Failed</span> : 
                          <span className="text-emerald-600 font-medium">Success</span>}
                      </td>
                      <td className="px-4 py-3 font-mono">{inv.invoiceNumber || '-'}</td>
                      <td className="px-4 py-3 truncate max-w-[150px]" title={inv.supplierName}>{inv.supplierName || '-'}</td>
                      <td className="px-4 py-3 font-mono text-slate-500">{inv.supplierVatNumber || '-'}</td>
                      <td className="px-4 py-3 whitespace-nowrap"><span className="bg-slate-100 px-2 py-1 rounded text-[10px] font-semibold">{inv.paidBy}</span></td>
                      <td className="px-4 py-3 text-right font-bold">{inv.currency} {inv.claimAmountOverride || inv.grandTotal || '-'}</td>
                      <td className="px-4 py-3">
                         <div className="flex justify-center gap-3">
                            {inv.fileUrl && (
                               <a href={inv.fileUrl} target="_blank" rel="noopener noreferrer" download className="text-slate-500 hover:text-indigo-600" title="Download Original">
                                  <FileDown className="w-4 h-4" />
                               </a>
                            )}
                            <button onClick={() => setViewingInvoiceId(inv.id)} className="text-indigo-600 hover:text-indigo-800 font-medium">View</button>
                            <button onClick={() => setEditingInvoiceId(inv.id)} className="text-slate-500 hover:text-slate-800 font-medium">Edit</button>
                         </div>
                      </td>
                    </tr>
                  ))}
                  {filteredInvoices.length === 0 && (
                    <tr><td colSpan={8} className="px-4 py-12 text-center text-slate-400 italic">No invoices found for this view.</td></tr>
                  )}
                </tbody>
             </table>
          </div>

        </div>
      </main>

      {/* Edit Modal */}
      {editingInvoiceId && <EditModal invId={editingInvoiceId} invoices={invoices} onClose={() => setEditingInvoiceId(null)} onError={(msg) => addToast(msg, 'error')} />}
      
      {/* View Modal */}
      {viewingInvoiceId && <ViewModal invId={viewingInvoiceId} invoices={invoices} onClose={() => setViewingInvoiceId(null)} />}
      
      {/* Duplicate Resolution Modal */}
      {duplicateConflicts.length > 0 && <DuplicateModal conflict={duplicateConflicts[0]} onResolve={handleResolveDuplicate} invoices={invoices} />}

      {/* Toasts */}
      <div className="fixed bottom-4 right-4 z-[150] space-y-2 pointer-events-none">
         {toasts.map(toast => (
            <div key={toast.id} className={`flex items-center gap-3 px-4 py-3 rounded-lg shadow-lg pointer-events-auto transition-all ${
               toast.type === 'error' ? 'bg-rose-600 text-white' :
               toast.type === 'success' ? 'bg-emerald-600 text-white' :
               toast.type === 'warning' ? 'bg-amber-500 text-white' :
               'bg-slate-800 text-white'
            }`}>
               {toast.type === 'error' ? <X className="w-5 h-5" /> : 
                toast.type === 'success' ? <CheckCircle className="w-5 h-5" /> : 
                <AlertCircle className="w-5 h-5" />}
               <p className="text-sm font-medium">{toast.message}</p>
            </div>
         ))}
      </div>
    </div>
  );
}

function DuplicateModal({ conflict, onResolve, invoices }: { conflict: any, onResolve: (docId: string, action: 'skip' | 'save') => void, invoices: FirestoreInvoice[] }) {
  const [viewingExisting, setViewingExisting] = useState(false);

  if (viewingExisting) {
     return <ViewModal invId={conflict.existingInvoice.id} invoices={invoices} onClose={() => setViewingExisting(false)} />;
  }

  return (
    <div className="fixed inset-0 z-[120] flex items-center justify-center bg-slate-900/50 backdrop-blur-sm p-4">
       <div className="bg-white rounded-xl shadow-xl w-full max-w-2xl overflow-hidden flex flex-col">
          <div className="p-4 border-b border-amber-200 bg-amber-50 flex items-center gap-3">
             <AlertCircle className="w-6 h-6 text-amber-600" />
             <h2 className="text-sm font-bold text-amber-900 uppercase tracking-wider">Duplicate Invoice Detected</h2>
          </div>
          <div className="p-6 space-y-6">
             <p className="text-sm text-slate-700">This invoice appears to be a duplicate of an existing record. Please review the details below.</p>
             
             <div className="grid grid-cols-2 gap-4">
                <div className="p-4 bg-slate-50 border border-slate-200 rounded-lg">
                   <h3 className="font-bold text-xs text-slate-500 uppercase mb-3">Existing Record</h3>
                   <div className="space-y-2 text-sm">
                      <div className="flex justify-between"><span className="text-slate-500">Invoice No:</span> <span className="font-medium text-slate-900">{conflict.existingInvoice.invoiceNumber || '-'}</span></div>
                      <div className="flex justify-between"><span className="text-slate-500">Supplier:</span> <span className="font-medium text-slate-900">{conflict.existingInvoice.supplierName || '-'}</span></div>
                      <div className="flex justify-between"><span className="text-slate-500">Total:</span> <span className="font-medium text-slate-900">{conflict.existingInvoice.currency} {conflict.existingInvoice.grandTotal || '-'}</span></div>
                      <div className="flex justify-between"><span className="text-slate-500">Date:</span> <span className="font-medium text-slate-900">{conflict.existingInvoice.invoiceDate || '-'}</span></div>
                   </div>
                   <button onClick={() => setViewingExisting(true)} className="mt-4 w-full py-1.5 text-xs font-semibold text-indigo-600 bg-indigo-50 hover:bg-indigo-100 rounded">View Full Details</button>
                </div>
                
                <div className="p-4 bg-white border border-indigo-200 rounded-lg shadow-sm">
                   <h3 className="font-bold text-xs text-indigo-500 uppercase mb-3">New Upload</h3>
                   <div className="space-y-2 text-sm">
                      <div className="flex justify-between"><span className="text-slate-500">Invoice No:</span> <span className="font-medium text-slate-900">{conflict.newInvoice.invoiceNumber || '-'}</span></div>
                      <div className="flex justify-between"><span className="text-slate-500">Supplier:</span> <span className="font-medium text-slate-900">{conflict.newInvoice.supplierName || '-'}</span></div>
                      <div className="flex justify-between"><span className="text-slate-500">Total:</span> <span className="font-medium text-slate-900">{conflict.newInvoice.currency} {conflict.newInvoice.grandTotal || '-'}</span></div>
                      <div className="flex justify-between"><span className="text-slate-500">Date:</span> <span className="font-medium text-slate-900">{conflict.newInvoice.invoiceDate || '-'}</span></div>
                   </div>
                </div>
             </div>
          </div>
          <div className="p-4 border-t border-slate-200 bg-slate-50 flex justify-end gap-3">
             <button onClick={() => onResolve(conflict.docId, 'save')} className="px-4 py-2 text-red-600 font-medium hover:bg-red-50 rounded-md">Save Anyway (Force)</button>
             <button onClick={() => onResolve(conflict.docId, 'skip')} className="px-5 py-2 bg-indigo-600 text-white font-semibold rounded-md hover:bg-indigo-700 shadow-sm">Skip & Do Not Save</button>
          </div>
       </div>
    </div>
  );
}

function EditModal({ invId, invoices, onClose, onError }: { invId: string, invoices: FirestoreInvoice[], onClose: () => void, onError: (msg: string) => void }) {
  const invoice = invoices.find(i => i.id === invId);
  const [formData, setFormData] = useState<Partial<FirestoreInvoice>>(invoice || {});
  
  useEffect(() => { setFormData(invoice || {}); }, [invoice]);

  const handleChange = (e: React.ChangeEvent<HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement>) => {
    setFormData(prev => ({ ...prev, [e.target.name]: e.target.value }));
  };

  const handleSave = async () => {
    try {
      await updateDoc(doc(db, 'invoices', invId), {
        ...formData,
        updatedAt: Date.now()
      });
      await addDoc(collection(db, 'auditLogs'), {
         action: 'Edit',
         invoiceId: invId,
         userId: auth.currentUser?.uid ?? 'anonymous',
         changes: { updated: true },
         createdAt: Date.now()
      });
      onClose();
    } catch(e) {
       console.error("Save failed:", e);
       onError('Failed to save changes.');
    }
  };

  if(!invoice) return null;

  return (
    <div className="fixed inset-0 z-[100] flex items-center justify-center bg-slate-900/50 backdrop-blur-sm p-4">
      <div className="bg-white rounded-xl shadow-xl w-full max-w-3xl max-h-[90vh] overflow-hidden flex flex-col">
          <div className="p-4 border-b border-slate-200 flex justify-between items-center bg-slate-50">
             <h2 className="text-sm font-bold text-slate-800 uppercase tracking-wider">Edit Invoice Record</h2>
             <button onClick={onClose} className="text-slate-400 hover:text-slate-700"><X className="w-5 h-5" /></button>
          </div>
          <div className="p-6 overflow-y-auto custom-scrollbar flex-1 space-y-6">
             <div className="grid grid-cols-2 md:grid-cols-3 gap-4">
                <Input label="Invoice Number" name="invoiceNumber" val={formData.invoiceNumber} onChange={handleChange} />
                <Input label="Invoice Date" name="invoiceDate" val={formData.invoiceDate} onChange={handleChange} />
                <Input label="Currency" name="currency" val={formData.currency} onChange={handleChange} />
                <Input label="Supplier Name" name="supplierName" val={formData.supplierName} onChange={handleChange} />
                <Input label="Supplier VAT" name="supplierVatNumber" val={formData.supplierVatNumber} onChange={handleChange} />
                <Input label="Customer Name" name="customerName" val={formData.customerName} onChange={handleChange} />
                <Input label="Subtotal" name="subtotal" val={formData.subtotal} onChange={handleChange} />
                <Input label="VAT Amount" name="vatAmount" val={formData.vatAmount} onChange={handleChange} />
                <Input label="Grand Total" name="grandTotal" val={formData.grandTotal} onChange={handleChange} />
                <Input label="Paid By Method" name="paidBy" val={formData.paidBy} onChange={handleChange} isSelect options={["Company Account", "Company Card", "Employee Personal Account", "Employee Cash"]} />
                <Input label="Expense Category" name="expenseCategory" val={formData.expenseCategory} onChange={handleChange} />
                <Input label="Claim Status" name="claimStatus" val={formData.claimStatus} onChange={handleChange} isSelect options={["Draft", "Submitted", "Under Review", "Approved", "Paid / Reimbursed"]} />
                <Input label="Employee Name" name="employeeName" val={formData.employeeName} onChange={handleChange} />
                <div className="col-span-1 md:col-span-3">
                   <label className="block text-[10px] font-bold text-slate-500 uppercase mb-1">Notes</label>
                   <textarea name="notes" value={formData.notes || ''} onChange={handleChange} className="w-full p-2 border border-slate-200 rounded-md text-sm outline-none focus:border-indigo-500 h-20" />
                </div>
             </div>
          </div>
          <div className="p-4 border-t border-slate-200 bg-slate-50 flex justify-end gap-3">
             <button onClick={onClose} className="px-4 py-2 text-slate-600 font-medium">Cancel</button>
             <button onClick={handleSave} className="px-5 py-2 bg-indigo-600 text-white font-semibold rounded-md hover:bg-indigo-700">Save Changes</button>
          </div>
      </div>
    </div>
  );
}

function ViewModal({ invId, invoices, onClose }: { invId: string, invoices: FirestoreInvoice[], onClose: () => void }) {
  const inv = invoices.find(i => i.id === invId);
  if(!inv) return null;

  return (
    <div className="fixed inset-0 z-[100] flex items-center justify-center bg-slate-900/50 backdrop-blur-sm p-4">
      <div className="bg-white rounded-xl shadow-xl w-full max-w-5xl h-[90vh] flex flex-col overflow-hidden">
         <div className="p-4 border-b border-slate-200 flex justify-between items-center bg-slate-50 shrink-0">
             <h2 className="text-sm font-bold text-slate-800 uppercase tracking-wider">Invoice Details: {inv.fileName}</h2>
             <button onClick={onClose} className="text-slate-400 hover:text-slate-700"><X className="w-5 h-5" /></button>
          </div>
          <div className="flex-1 flex flex-col md:flex-row overflow-hidden">
             {/* Left side: Img */}
             <div className="w-full md:w-1/2 border-r border-slate-200 bg-slate-100 flex flex-col relative h-[40vh] md:h-full">
                {inv.fileUrl ? (
                   <iframe src={inv.fileUrl} className="w-full h-full border-0 absolute inset-0" title="Invoice" />
                ) : (
                   <div className="m-auto text-slate-400 text-sm">No preview available</div>
                )}
             </div>
             {/* Right side: Data */}
             <div className="w-full md:w-1/2 p-6 overflow-y-auto space-y-6 custom-scrollbar bg-white">
                <h3 className="font-bold text-lg border-b pb-2">Extracted Information</h3>
                <div className="grid grid-cols-2 gap-y-4 gap-x-6 text-sm">
                   <DataField label="Invoice Number" val={inv.invoiceNumber} />
                   <DataField label="Invoice Date" val={inv.invoiceDate} />
                   <DataField label="Supplier Name" val={inv.supplierName} />
                   <DataField label="Supplier VAT" val={inv.supplierVatNumber} />
                   <DataField label="Customer Name" val={inv.customerName} />
                   <DataField label="Processing Status" val={inv.processingStatus} />
                </div>
                
                <h3 className="font-bold text-lg border-b pb-2 pt-4">Financial Summary</h3>
                <div className="grid grid-cols-2 gap-y-4 gap-x-6 text-sm">
                   <DataField label="Currency" val={inv.currency} />
                   <DataField label="Subtotal" val={inv.subtotal} />
                   <DataField label="VAT Amount" val={inv.vatAmount} />
                   <DataField label="Grand Total" val={inv.grandTotal} highlight />
                </div>

                <h3 className="font-bold text-lg border-b pb-2 pt-4">Payment & Claim Info</h3>
                <div className="grid grid-cols-2 gap-y-4 gap-x-6 text-sm">
                   <DataField label="Paid By" val={inv.paidBy} />
                   <DataField label="Expense Category" val={inv.expenseCategory} />
                   {(inv.employeeName || isEmployeePaid(inv.paidBy)) && (
                      <>
                        <DataField label="Employee" val={inv.employeeName} />
                        <DataField label="Claim Status" val={inv.claimStatus} />
                      </>
                   )}
                </div>
                <div className="text-sm">
                   <span className="block text-[10px] font-bold text-slate-500 uppercase">Notes</span>
                   <p className="mt-1 text-slate-800 whitespace-pre-wrap">{inv.notes || 'None'}</p>
                </div>
             </div>
          </div>
      </div>
    </div>
  );
}

function DataField({ label, val, highlight }: { label: string, val: any, highlight?: boolean }) {
  return (
    <div>
      <div className="text-[10px] font-bold text-slate-500 uppercase tracking-wider">{label}</div>
      <div className={`mt-0.5 font-medium ${highlight ? 'text-indigo-600 text-lg' : 'text-slate-800'}`}>{val || '-'}</div>
    </div>
  );
}

function Input({ label, name, val, onChange, isSelect, options }: any) {
  return (
    <div>
      <label className="block text-[10px] font-bold text-slate-500 uppercase mb-1">{label}</label>
      {isSelect ? (
         <select name={name} value={val || ''} onChange={onChange} className="w-full text-sm border border-slate-200 outline-none p-2 rounded-md focus:border-indigo-500">
           {options.map((o: string) => <option key={o} value={o}>{o}</option>)}
         </select>
      ) : (
         <input type="text" name={name} value={val || ''} onChange={onChange} className="w-full text-sm border border-slate-200 outline-none p-2 rounded-md focus:border-indigo-500" />
      )}
    </div>
  );
}

