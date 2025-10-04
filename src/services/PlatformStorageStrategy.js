// src/services/PlatformStorageStrategy.js
import { Platform } from 'react-native';
import AsyncStorage from '@react-native-async-storage/async-storage';
import CloudinaryService from './CloudinaryService';
import { db } from '../config/firebase.config';

let RNFS = null;
if (Platform.OS !== 'web') {
  RNFS = require('react-native-fs');
}

class PlatformStorageStrategy {
  constructor() {
    this.isWeb = Platform.OS === 'web';
    this.isMobile = !this.isWeb;
  }

  async storeDocument(file, userId) {
    if (this.isMobile) {
      return await this.storeMobileOfflineFirst(file, userId);
    } else {
      return await this.storeWebCloudFirst(file, userId);
    }
  }

  // MOBILE: Offline-first with background cloud sync
  async storeMobileOfflineFirst(file, userId) {
    try {
      const documentId = `doc_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
      const fileName = `${documentId}_${file.name}`;
      const localPath = `${RNFS.DocumentDirectoryPath}/${fileName}`;
      
      // Store locally first
      await RNFS.copyFile(file.uri, localPath);
      
      const document = {
        id: documentId,
        localPath: localPath,
        originalName: file.name,
        size: file.size,
        type: file.type,
        storageStrategy: 'mobile_offline_first',
        cloudBackup: null,
        cloudinarySyncStatus: 'pending',
        uploadedAt: new Date().toISOString(),
        platform: 'mobile',
        processed: false,
      };
      
      // Save to AsyncStorage immediately
      await this.saveToAsyncStorage(document);
      
      // Background cloud sync (non-blocking)
      this.syncToCloudBackground(document, file, userId);
      
      return { success: true, document };
    } catch (error) {
      console.error('Mobile storage error:', error);
      throw error;
    }
  }

  // WEB: Local-first with immediate cloud backup
// WEB: Cloud-first with minimal local storage
async storeWebCloudFirst(file, userId) {
  try {
    console.log('🌐 Web storage: Cloud-first minimal local storage');
    
    // STEP 1: Upload to Cloudinary immediately (primary storage)
    const cloudinaryResult = await CloudinaryService.uploadDocument(
      file.uri || file.path,
      file.name,
      userId
    );
    
    console.log('✅ Cloudinary upload successful:', cloudinaryResult.publicId);
    
    // STEP 2: Store minimal metadata locally (no file data!)
    const documentId = `doc_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
    
    const document = {
      id: documentId,
      originalName: file.name,
      size: file.size,
      type: file.type,
      cloudinaryUrl: cloudinaryResult.url,
      cloudinaryPublicId: cloudinaryResult.publicId,
      storageStrategy: 'web_cloud_primary',
      cloudinarySyncStatus: 'synced',
      uploadedAt: new Date().toISOString(),
      platform: 'web',
      processed: false,
      // Don't store webFileData - use Cloudinary as source of truth
    };
    
    // STEP 3: Save minimal metadata to AsyncStorage
    await this.saveToAsyncStorage(document);
    
    // STEP 4: Cache metadata in Firebase
    await this.cacheInFirebase(document, userId);
    
    console.log('✅ Document stored in cloud, minimal local metadata saved');
    
    return { success: true, document };
  } catch (error) {
    console.error('❌ Web cloud storage error:', error);
    throw error;
  }
}

  // Background Cloudinary upload for web
  async uploadToCloudinaryBackground(document, file, userId) {
    try {
      console.log('☁️ Starting background Cloudinary upload...');
      
      document.cloudinarySyncStatus = 'uploading';
      await this.updateAsyncStorage(document);
      
      const cloudinaryResult = await CloudinaryService.uploadDocument(
        file.uri || file.path,
        file.name,
        userId
      );
      
      console.log('✅ Background Cloudinary upload successful:', cloudinaryResult.publicId);
      
      // Update document with cloud info
      document.cloudinaryUrl = cloudinaryResult.url;
      document.cloudinaryPublicId = cloudinaryResult.publicId;
      document.cloudinarySyncStatus = 'synced';
      document.cloudinaryBackedUpAt = new Date().toISOString();
      
      await this.updateAsyncStorage(document);
      await this.cacheInFirebase(document, userId);
      
      console.log('✅ Document fully synced to cloud');
      
    } catch (error) {
      console.warn('⚠️ Background Cloudinary upload failed:', error.message);
      document.cloudinarySyncStatus = 'failed';
      document.cloudinaryLastError = error.message;
      await this.updateAsyncStorage(document);
    }
  }

  // Background cloud sync for mobile
  async syncToCloudBackground(document, file, userId) {
    try {
      console.log('☁️ Starting background cloud sync for:', document.id);
      
      const cloudinaryResult = await CloudinaryService.uploadDocumentAsync(
        file,
        userId
      );
      
      document.cloudBackup = cloudinaryResult;
      document.cloudinarySyncStatus = 'synced';
      document.cloudinaryPublicId = cloudinaryResult.publicId;
      
      await this.updateAsyncStorage(document);
      
      console.log('✅ Background cloud sync completed:', document.id);
    } catch (error) {
      console.warn('⚠️ Background cloud sync failed:', error.message);
      document.cloudinarySyncStatus = 'failed';
      await this.updateAsyncStorage(document);
    }
  }

  // Firebase cache for web platform
  async cacheInFirebase(document, userId) {
    try {
      if (Platform.OS === 'web') {
        const { doc, setDoc } = require('firebase/firestore');
        
        await setDoc(doc(db, 'users', userId, 'documents', document.id), {
          ...document,
          cachedAt: new Date().toISOString(),
          cacheSource: 'web_upload'
        });
        
        console.log('✅ Document cached in Firebase:', document.id);
      } else {
        // Mobile Firebase cache
        await db
          .collection('users')
          .doc(userId)
          .collection('documents')
          .doc(document.id)
          .set({
            ...document,
            cachedAt: new Date().toISOString(),
            cacheSource: 'mobile_upload'
          });
      }
    } catch (error) {
      console.warn('⚠️ Firebase cache failed (non-critical):', error.message);
      // Don't throw - caching is optional
    }
  }

  // Get document content (platform-aware)
  async getDocumentContent(document) {
    try {
      if (this.isMobile && document.localPath) {
        // Mobile: Read from local storage
        return await RNFS.readFile(document.localPath, 'base64');
      } else if (this.isWeb && document.webFileData) {
        // Web: Use locally stored file data (PRIORITY)
        console.log('Using locally stored web file data');
        return new Uint8Array(document.webFileData);
      } else if (document.cloudinaryPublicId) {
        // Fallback: Download from Cloudinary (only if local data missing)
        console.log('Local data missing, downloading from Cloudinary...');
        const result = await CloudinaryService.downloadDocument(
          document.cloudinaryPublicId
        );
        return result.data;
      } else {
        throw new Error('No accessible document source found');
      }
    } catch (error) {
      console.error('Error getting document content:', error);
      throw error;
    }
  }

  // Restore from Firebase cache (web platform)
  async restoreFromFirebaseCache(userId) {
    try {
      if (Platform.OS === 'web') {
        const { collection, getDocs } = require('firebase/firestore');
        
        const snapshot = await getDocs(
          collection(db, 'users', userId, 'documents')
        );
        
        const cachedDocuments = [];
        snapshot.forEach(doc => {
          cachedDocuments.push(doc.data());
        });
        
        console.log('✅ Restored', cachedDocuments.length, 'documents from Firebase cache');
        
        // Merge with AsyncStorage
        const localDocs = await this.getStoredDocuments();
        const mergedDocs = this.mergeDocuments(localDocs, cachedDocuments);
        
        await AsyncStorage.setItem('coaching_documents', JSON.stringify(mergedDocs));
        
        return mergedDocs;
      }
    } catch (error) {
      console.warn('Could not restore from Firebase cache:', error);
      return await this.getStoredDocuments();
    }
  }

  // Merge local and cached documents (avoid duplicates)
  mergeDocuments(localDocs, cachedDocs) {
    const merged = [...localDocs];
    const localIds = new Set(localDocs.map(doc => doc.id));
    
    cachedDocs.forEach(cachedDoc => {
      if (!localIds.has(cachedDoc.id)) {
        merged.push(cachedDoc);
      }
    });
    
    return merged;
  }

  // AsyncStorage helpers
  async saveToAsyncStorage(document) {
    const documents = await this.getStoredDocuments();
    documents.push(document);
    await AsyncStorage.setItem('coaching_documents', JSON.stringify(documents));
  }

  async updateAsyncStorage(updatedDocument) {
    const documents = await this.getStoredDocuments();
    const index = documents.findIndex(doc => doc.id === updatedDocument.id);
    if (index >= 0) {
      documents[index] = updatedDocument;
      await AsyncStorage.setItem('coaching_documents', JSON.stringify(documents));
    }
  }

  async getStoredDocuments() {
    try {
      const docs = await AsyncStorage.getItem('coaching_documents');
      return docs ? JSON.parse(docs) : [];
    } catch (error) {
      console.error('Error loading stored documents:', error);
      return [];
    }
  }

  // Get storage statistics
  async getStorageStats() {
    const documents = await this.getStoredDocuments();
    
    return {
      totalDocuments: documents.length,
      platformBreakdown: {
        web: documents.filter(d => d.platform === 'web').length,
        mobile: documents.filter(d => d.platform === 'mobile').length
      },
      syncStatus: {
        synced: documents.filter(d => d.cloudinarySyncStatus === 'synced').length,
        pending: documents.filter(d => d.cloudinarySyncStatus === 'pending').length,
        failed: documents.filter(d => d.cloudinarySyncStatus === 'failed').length
      },
      totalSize: documents.reduce((sum, doc) => sum + (doc.size || 0), 0)
    };
  }
}

export default new PlatformStorageStrategy();
