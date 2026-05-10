// This file used to host a standalone SpreadsheetImportModal that the
// Families list opened as a separate dialog. The CSV/XLSX import flow has
// since been folded into FamilyEditModal (Add family → Import spreadsheet
// in-form wizard), and this component has no remaining consumers.
//
// Keeping a tiny stub instead of deleting the file because the workspace
// disallows file removal in this sandbox. The actual import logic lives
// in `src/services/spreadsheetImport.ts` and the wizard UI lives in
// `src/components/FamilyEditModal.tsx`.
export {};
