// src/services/CloudinaryService.js
import axios from 'axios';
import * as FileSystem from 'expo-file-system';
import { Platform } from 'react-native';

const CLOUD_NAME = 'dkyhectpt'
const UPLOAD_PRESET = 'accella_foundation';

class CloudinaryService {
  constructor() {
    this.uploadUrl = `https://api.cloudinary.com/v1_1/${CLOUD_NAME}/upload`;  // FIXED
  }

  /**
   * Check if document exists in Cloudinary
   */
  async checkDocumentExists(publicId) {
    try {
      const url = `https://res.cloudinary.com/${CLOUD_NAME}/raw/upload/${publicId}`;
      const response = await axios.head(url, { timeout: 5000 });
      
      return { 
        exists: true, 
        size: response.headers['content-length'],
        contentType: response.headers['content-type']
      };
    } catch (error) {
      if (error.response?.status === 404) {
        return { exists: false };
      }
      throw error;
    }
  }

  /**
   * Get direct URL for document viewing/downloading
   */
  getDocumentUrl(publicId) {
    return `https://res.cloudinary.com/${CLOUD_NAME}/raw/upload/${publicId}`;
  }

  /**
   * Download document from Cloudinary
   */
  async downloadDocument(publicId) {
    try {
      console.log('Downloading from Cloudinary:', publicId);
      
      const url = this.getDocumentUrl(publicId);
      const response = await axios.get(url, { 
        responseType: 'arraybuffer',
        timeout: 30000,
        onDownloadProgress: (progressEvent) => {
          const percentCompleted = Math.round((progressEvent.loaded * 100) / progressEvent.total);
          console.log('Download progress:', percentCompleted + '%');
        }
      });
      
      return {
        success: true,
        data: response.data,
        contentType: response.headers['content-type'],
        size: response.data.byteLength
      };
    } catch (error) {
      console.error('Cloudinary download error:', error);
      throw this.handleUploadError(error);
    }
  }

  /**
   * Upload document to Cloudinary
   * @param {string} fileUri - Local file URI
   * @param {string} fileName - Original file name
   * @param {string} userId - User ID for folder organization
   * @returns {Promise<Object>} Upload result with URL and metadata
   */
async uploadDocument(fileUri, fileName, userId) {
  try {
    console.log('Starting Cloudinary upload:', fileName);
    
    let base64Data;
    
    // Platform-specific file reading
    if (Platform.OS === 'web') {
      // WEB: Use fetch to get the blob, then convert to base64
      try {
        const response = await fetch(fileUri);
        const blob = await response.blob();
        base64Data = await this.blobToBase64(blob);
      } catch (error) {
        throw new Error(`Could not read file on web: ${error.message}`);
      }
    } else {
      // NATIVE: Use FileSystem
      base64Data = await FileSystem.readAsStringAsync(fileUri, {
        encoding: FileSystem.EncodingType.Base64,
      });
    }

    // Sanitize the filename - remove all special characters
    const sanitizedFileName = fileName
      .replace(/\s+/g, '_')           // Replace spaces with underscores
      .replace(/[^a-zA-Z0-9._-]/g, '') // Remove special chars except . _ -
      .replace(/\.+/g, '.')           // Replace multiple dots with single dot
      .substring(0, 200);             // Limit length
    
    // Create public_id WITH folder structure included (no separate folder param)
    const timestamp = Date.now();
    const publicIdWithPath = `users/${userId}/documents/${timestamp}_${sanitizedFileName}`;

    const formData = new FormData();
    formData.append('file', `data:application/octet-stream;base64,${base64Data}`);
    formData.append('upload_preset', UPLOAD_PRESET);
    formData.append('public_id', publicIdWithPath);  // ✅ Folder path IN the public_id
    formData.append('resource_type', 'raw');
    // DON'T add folder parameter - it conflicts with public_id
    
    const response = await axios.post(this.uploadUrl, formData, {
      headers: { 
        'Content-Type': 'multipart/form-data',
        'Accept': 'application/json'
      },
      timeout: 60000,
      onUploadProgress: (progressEvent) => {
        const percentCompleted = Math.round((progressEvent.loaded * 100) / progressEvent.total);
        console.log('Cloudinary upload progress:', percentCompleted + '%');
      }
    });

    console.log('Cloudinary upload successful:', response.data.public_id);

    return {
      success: true,
      url: response.data.secure_url,
      publicId: response.data.public_id,
      originalName: fileName,
      cloudinaryName: response.data.public_id.split('/').pop(),
      size: response.data.bytes,
      format: response.data.format
    };
  } catch (error) {
    console.error('Cloudinary upload failed:', error);
    throw this.handleUploadError(error);
  }
}

// Helper method for web: convert Blob to base64
blobToBase64(blob) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onloadend = () => {
      // Remove the data URL prefix (data:*/*;base64,)
      const base64String = reader.result.split(',')[1];
      resolve(base64String);
    };
    reader.onerror = reject;
    reader.readAsDataURL(blob);
  });
}

  /**
   * Get resource type based on file extension
   */
  getResourceType(fileName) {
    const extension = fileName.split('.').pop().toLowerCase();
    
    const imageExtensions = ['jpg', 'jpeg', 'png', 'gif', 'webp', 'svg'];
    const videoExtensions = ['mp4', 'mov', 'avi', 'webm'];
    
    if (imageExtensions.includes(extension)) return 'image';
    if (videoExtensions.includes(extension)) return 'video';
    return 'auto'; // For documents (PDF, DOCX, etc.)
  }

  /**
   * Delete document from Cloudinary (requires backend)
   */
  async deleteDocument(publicId) {
    console.warn('⚠️ Cloudinary deletion requires backend API with signed requests');
    console.log('Public ID to delete:', publicId);
    
    return {
      success: false,
      message: 'Delete operation requires backend implementation',
      publicId
    };
  }

  /**
   * Get optimized URL for display
   */
  getOptimizedUrl(publicId, options = {}) {
    const {
      width = 800,
      height = null,
      quality = 'auto',
      format = 'auto',
      crop = 'limit'
    } = options;

    let transformations = `w_${width},q_${quality},f_${format},c_${crop}`;
    if (height) {
      transformations += `,h_${height}`;
    }

    return `https://res.cloudinary.com/${CLOUD_NAME}/image/upload/${transformations}/${publicId}`;  // FIXED
  }

  /**
   * Handle upload errors
   */
  handleUploadError(error) {
    if (error.response) {
      return new Error(`Cloudinary error: ${error.response.data.error.message}`);
    } else if (error.request) {
      return new Error('Network error: Please check your internet connection');
    } else {
      return new Error(`Upload failed: ${error.message}`);
    }
  }

  /**
   * Validate file before upload
   */
  validateFile(fileSize, fileName) {
    const maxSize = 10 * 1024 * 1024; // 10MB for free tier
    
    if (fileSize > maxSize) {
      return {
        valid: false,
        error: 'File size exceeds 10MB limit'
      };
    }

    const allowedExtensions = ['pdf', 'doc', 'docx', 'xls', 'xlsx', 'txt', 'csv'];
    const extension = fileName.split('.').pop().toLowerCase();
    
    if (!allowedExtensions.includes(extension)) {
      return {
        valid: false,
        error: `File type .${extension} is not supported`
      };
    }

    return { valid: true };
  }
}

export default new CloudinaryService();
