// src/services/CloudinaryService.js
import axios from 'axios';
import * as FileSystem from 'expo-file-system';
import { Platform } from 'react-native';

const CLOUD_NAME = 'dkyhectpt'
const UPLOAD_PRESET = 'accella_foundation';

class CloudinaryService {
  constructor() {
    this.uploadUrl = `https://api.cloudinary.com/v1_1/${CLOUD_NAME}/upload`;
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
   * Helper Method for async upload
   */
  async uploadDocumentAsync(file, userId) {
    try {
      return await this.uploadDocument(file.uri || file.path, file.name, userId);
    } catch (error) {
      console.warn('Async upload failed:', error);
      throw error;
    }
  }

  /**
   * Upload document to Cloudinary with size optimization warnings
   */
  async uploadDocument(fileUri, fileName, userId) {
    try {
      console.log('Starting Cloudinary upload:', fileName);
      
      let base64Data;
      let fileSize = 0;
      
      // Platform-specific file reading
      if (Platform.OS === 'web') {
        try {
          const response = await fetch(fileUri);
          const blob = await response.blob();
          fileSize = blob.size;
          
          // Warn about large files
          if (fileSize > 5 * 1024 * 1024) {
            console.warn(`⚠️ Large file detected (${this.formatFileSize(fileSize)}). Consider removing images for faster processing.`);
          }
          
          base64Data = await this.blobToBase64(blob);
        } catch (error) {
          throw new Error(`Could not read file on web: ${error.message}`);
        }
      } else {
        // Native: Get file info first
        try {
          const fileInfo = await FileSystem.getInfoAsync(fileUri);
          fileSize = fileInfo.size || 0;
          
          if (fileSize > 5 * 1024 * 1024) {
            console.warn(`⚠️ Large file detected (${this.formatFileSize(fileSize)}). Consider removing images for faster processing.`);
          }
        } catch (error) {
          console.warn('Could not get file info:', error.message);
        }
        
        base64Data = await FileSystem.readAsStringAsync(fileUri, {
          encoding: FileSystem.EncodingType.Base64,
        });
      }

      // Sanitize filename
      const sanitizedFileName = fileName
        .replace(/\s+/g, '_')
        .replace(/[^a-zA-Z0-9._-]/g, '')
        .replace(/\.+/g, '.')
        .substring(0, 200);
      
      const timestamp = Date.now();
      const publicIdWithPath = `users/${userId}/documents/${timestamp}_${sanitizedFileName}`;

      const formData = new FormData();
      formData.append('file', `data:application/octet-stream;base64,${base64Data}`);
      formData.append('upload_preset', UPLOAD_PRESET);
      formData.append('public_id', publicIdWithPath);
      formData.append('resource_type', 'raw');
      
      const response = await axios.post(this.uploadUrl, formData, {
        headers: { 
          'Content-Type': 'multipart/form-data',
          'Accept': 'application/json'
        },
        timeout: 120000, // Increased to 2 minutes for large files
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
        format: response.data.format,
        isLargeFile: fileSize > 5 * 1024 * 1024
      };
    } catch (error) {
      console.error('Cloudinary upload failed:', error);
      throw this.handleUploadError(error);
    }
  }

  /**
   * Helper: Convert Blob to base64
   */
  blobToBase64(blob) {
    return new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onloadend = () => {
        const base64String = reader.result.split(',')[1];
        resolve(base64String);
      };
      reader.onerror = reject;
      reader.readAsDataURL(blob);
    });
  }

  /**
   * Format file size for display
   */
  formatFileSize(bytes) {
    const sizes = ['Bytes', 'KB', 'MB', 'GB'];
    if (bytes === 0) return '0 Bytes';
    const i = Math.floor(Math.log(bytes) / Math.log(1024));
    return Math.round(bytes / Math.pow(1024, i) * 100) / 100 + ' ' + sizes[i];
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
    return 'auto';
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

    return `https://res.cloudinary.com/${CLOUD_NAME}/image/upload/${transformations}/${publicId}`;
  }

  /**
   * Handle upload errors
   */
  handleUploadError(error) {
    if (error.response) {
      const errorMsg = error.response.data?.error?.message || 'Unknown error';
      return new Error(`Cloudinary error: ${errorMsg}`);
    } else if (error.request) {
      return new Error('Network error: Please check your internet connection');
    } else {
      return new Error(`Upload failed: ${error.message}`);
    }
  }

  /**
   * Validate file before upload with detailed feedback
   */
  validateFile(fileSize, fileName) {
    const maxSize = 10 * 1024 * 1024; // 10MB
    const optimalSize = 3 * 1024 * 1024; // 3MB optimal
    
    if (fileSize > maxSize) {
      return {
        valid: false,
        error: 'File size exceeds 10MB limit',
        suggestion: 'Remove images from the document to reduce file size'
      };
    }

    // Warning for large but acceptable files
    if (fileSize > optimalSize) {
      return {
        valid: true,
        warning: `File is large (${this.formatFileSize(fileSize)}). Consider removing images for faster processing.`,
        isLarge: true
      };
    }

    const allowedExtensions = ['pdf', 'doc', 'docx', 'xls', 'xlsx', 'txt', 'csv'];
    const extension = fileName.split('.').pop().toLowerCase();
    
    if (!allowedExtensions.includes(extension)) {
      return {
        valid: false,
        error: `File type .${extension} is not supported`,
        suggestion: 'Use PDF, Word, Excel, or text files'
      };
    }

    return { 
      valid: true,
      isOptimal: fileSize <= optimalSize
    };
  }

  /**
   * Get upload recommendations based on file characteristics
   */
  getUploadRecommendations(fileSize, fileName) {
    const validation = this.validateFile(fileSize, fileName);
    
    if (!validation.valid) {
      return {
        canUpload: false,
        message: validation.error,
        suggestions: [validation.suggestion]
      };
    }

    if (validation.isLarge) {
      return {
        canUpload: true,
        message: validation.warning,
        suggestions: [
          'Images will be ignored during text extraction',
          'Remove images to reduce upload time',
          'Optimal file size is under 3MB'
        ]
      };
    }

    return {
      canUpload: true,
      message: 'File is optimal for processing',
      suggestions: []
    };
  }
}

export default new CloudinaryService();