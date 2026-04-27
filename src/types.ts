export interface UploadState {
  id: string;
  fileName: string;
  status: 'Uploading' | 'Processing OCR' | 'Duplicate Check' | 'Completed' | 'Failed' | 'Skipped';
  progress: number;
}

export interface FirestoreInvoice {
  id: string; // Document ID
  fileName: string;
  fileUrl: string;
  uploadedAt: number;
  processedAt: number;
  processingStatus: string; // 'Processing', 'Success', 'Failed'
  invoiceNumber: string;
  invoiceDate: string;
  supplierName: string;
  supplierVatNumber: string;
  customerName: string;
  currency: string;
  subtotal: string | number;
  vatAmount: string | number;
  grandTotal: string | number;
  expenseCategory: string;
  paidBy: string;
  employeeName: string;
  employeeId: string;
  department: string;
  claimStatus: string;
  approvalStatus: string;
  validationStatus: string;
  notes: string;
  lineItems: any[];
  ocrRawData: any;
  updatedAt: number;
  error?: string;
  claimAmountOverride?: string;
  isDuplicate?: boolean;
  duplicateOf?: string;
}
