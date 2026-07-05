// Ambient types for the Workshop & Stores client.
//
// The app compiles as a classic (non-module) script, so everything here is
// global. CDN libraries (Chart.js, Tailwind) are declared rather than
// imported, and the DOM query helpers are widened to `any` because the app
// predates TypeScript and works with elements by id throughout — narrowing
// them file-wide would need thousands of casts for no runtime benefit.

declare const Chart: any;

interface Document {
    getElementById(elementId: string): any;
    querySelector(selectors: string): any;
    querySelectorAll(selectors: string): any;
}

interface Window {
    errors: any[];
    [key: string]: any;
}

// ---- Domain records (as served by the API) --------------------------------

/** An MRN request line (items table). */
interface Item {
    id: number | string;            // string while an optimistic temp id
    mrnNum: string;
    reqDate: string;
    reqDateISO?: string;
    vehicleMachinery: string;
    itemName: string;
    name?: string;                  // client alias of itemName
    itemDesc: string;
    reqQty: number;
    category?: string;
    requestSource?: 'Local' | 'Head Office' | null;
    jobCardId?: number | null;
    jobNo?: string | null;
    recQty?: number;                // computed rollups
    recCount?: number;
    recDate?: string | null;
    recDateISO?: string | null;
    hasUnpriced?: number;
    purchaseSource?: string;        // denormalised join of receipt sources
    receipts?: ReceiptRec[];
    createdAt?: string;
    updatedAt?: string;
}

/** A delivery / return transaction (receipts table). */
interface ReceiptRec {
    id: number | string;
    itemId: number | string;
    qty: number;
    transactionType: 'Receive' | 'Return' | string;
    deliveryDate: string | null;
    deliveryDateISO?: string | null;
    purchaseSource: string;         // canonical: 'Local Purchase' | 'Head Office Purchase'
    grnNumber?: string;
    invoiceNumber?: string;
    invoiceDate?: string;
    supplierName?: string;
    unitPrice?: number | null;
}

/** An item issued out of the store (issues table). */
interface IssueRec {
    id: number;
    issueDate: string;
    issueDateISO?: string;
    vehicleMachinery: string;
    itemName: string;
    itemDesc?: string;
    qty: number;
    category?: string;
    issuedTo?: string;
    issuedBy?: string;
    mrnNum?: string;
    purchaseSource?: string;
    notes?: string;
    unitPrice?: number | null;      // priced-out cost of the issued item
    itemId?: number | null;         // hard link to the request line
    jobCardId?: number | null;
    jobNo?: string | null;
}

interface BatteryRec {
    id: number;
    serialNumber: string;
    itemName?: string;
    itemDesc?: string;
    brand?: string;
    condition?: string;
    state?: string;
    currentVehicle?: string;
    purchaseDate?: string;
    expiryDate?: string;
    isExpired?: boolean | number;
    notes?: string;
    movements?: any[];
}

interface TransferRec {
    id: number;
    transferDate: string;
    mtnNum: string;
    itemName: string;
    itemDesc?: string;
    qty: number;
    category?: string;
    fromLocation?: string;
    toLocation?: string;
    transferredBy?: string;
    receivedBy?: string;
    mrnNum?: string;
    notes?: string;
}

interface JobCard {
    id: number;
    jobNo: string;
    type: string;
    status: string;
    date?: string;
    projectName?: string;
    vehicleMachinery?: string;
    [key: string]: any;             // wide record — job cockpit uses many fields
}

/** One queued offline write (localStorage 'delivery_sync_queue'). */
interface QueueAction {
    id: number | string;
    action: 'CREATE_ITEM' | 'UPDATE_ITEM' | 'DELETE_ITEM' | 'CREATE_RECEIPT' | 'UPDATE_RECEIPT' | 'DELETE_RECEIPT' | string;
    url: string;
    method: string;
    body: any;
    retries: number;
}
