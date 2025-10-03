// src/config/cloudinary.config.js
export const CLOUDINARY_CONFIG = {
  cloudName: process.env.CLOUDINARY_CLOUD_NAME || 'dkyhectpt',
  uploadPreset: process.env.CLOUDINARY_UPLOAD_PRESET || 'accella_foundation',
  
  // File size limits
  maxFileSize: 10 * 1024 * 1024, // 10MB
  
  // Allowed file types
  allowedTypes: ['pdf', 'doc', 'docx', 'xls', 'xlsx', 'txt', 'csv'],
  
  // Folder structure
  getFolderPath: (userId) => `users/${userId}/documents`,
};