import { Platform } from 'react-native';
import AsyncStorage from '@react-native-async-storage/async-storage';
import CloudinaryService from './CloudinaryService';
import SessionExtractor from './SessionExtractor';
import { db } from '../config/firebase.config';

class SessionExtractionStrategy {
  constructor() {
    this.isWeb = Platform.OS === 'web';
  }

  async extractSessions(documentId) {
    if (this.isWeb) {
      return await this.extractWebCloudBased(documentId);
    } else {
      return await this.extractMobileLocal(documentId);
    }
  }

async extractMobileLocal(documentId) {
  try {
    const DocumentProcessor = (await import('./DocumentProcessor')).default;
    const documents = await DocumentProcessor.getStoredDocuments();
    const document = documents.find(d => d.id === documentId);
    
    if (!document) throw new Error('Document not found');
    
    // Use DocumentProcessor's extraction (handles local file reading)
    const extractionResult = await DocumentProcessor.extractDocumentText(document);
    const text = extractionResult.text;
    
    const sessions = await SessionExtractor.extractSessionsFromDocument(document, { text });
    
    await AsyncStorage.setItem(
      `sessions_${documentId}`, 
      JSON.stringify(sessions)
    );
    
    this.syncToFirestore(documentId, sessions);
    
    return sessions;
  } catch (error) {
    throw error;
  }
}

async extractWebCloudBased(documentId) {
  try {
    // PRIORITY 1: Check Firestore cache for sessions
    const cachedSessions = await this.getFirestoreCache(documentId);
    if (cachedSessions) {
      console.log('✅ Using cached sessions from Firestore');
      return cachedSessions;
    }
    
    const DocumentProcessor = (await import('./DocumentProcessor')).default;
    const documents = await DocumentProcessor.getStoredDocuments();
    const document = documents.find(d => d.id === documentId);
    
    if (!document) throw new Error('Document not found');
    
    // Use DocumentProcessor's cached text extraction
    console.log('Extracting text using DocumentProcessor (with cache)...');
    const extractionResult = await DocumentProcessor.extractDocumentText(document);
    const text = extractionResult.text;
    
    console.log('Extracting sessions from text...');
    const sessionExtractor = (await import('./SessionExtractor')).default;
    const extractedData = await sessionExtractor.extractSessionsFromDocument(document, { text });
    
    // extractedData is an object with .sessions property
    const sessions = extractedData.sessions || [];
    
    console.log(`✅ Extracted ${sessions.length} sessions`);
    
    // Cache the sessions (pass the array, not the whole object)
    await this.cacheInFirestore(documentId, sessions);
    
    return sessions;
  } catch (error) {
    console.error('Web cloud-based extraction failed:', error);
    throw error;
  }
}

  async extractTextFromLocalFile(document) {
    const DocumentProcessor = (await import('./DocumentProcessor')).default;
    return await DocumentProcessor.extractDocumentText(document);
  }

  async extractTextFromBuffer(fileData) {
    const DocumentProcessor = (await import('./DocumentProcessor')).default;
    return await DocumentProcessor.extractTextFromBuffer(fileData.data);
  }

async cacheInFirestore(documentId, extractionResult) {
  try {
    const sessions = Array.isArray(extractionResult) 
      ? extractionResult 
      : extractionResult.sessions || [];
    
    if (!Array.isArray(sessions) || sessions.length === 0) {
      console.warn('No valid sessions to cache');
      return;
    }
    
    if (Platform.OS === 'web') {
      const { doc, setDoc, getFirestore } = require('firebase/firestore');
      const firestore = db || getFirestore();
      
      // Split sessions into chunks to avoid 1MB limit
      const SESSIONS_PER_CHUNK = 4; // 4 weeks per chunk (~350KB each)
      const chunks = [];
      
      for (let i = 0; i < sessions.length; i += SESSIONS_PER_CHUNK) {
        chunks.push(sessions.slice(i, i + SESSIONS_PER_CHUNK));
      }
      
      console.log(`Splitting ${sessions.length} weeks into ${chunks.length} chunks`);
      
      // Save metadata document
      await setDoc(doc(firestore, 'extractedSessions', documentId), {
        documentId,
        totalWeeks: sessions.length,
        totalSessions: sessions.reduce((sum, week) => 
          sum + (week.dailySessions?.length || 0), 0),
        chunksCount: chunks.length,
        extractedAt: new Date().toISOString(),
        platform: 'web',
        version: 3
      });
      
      // Save each chunk as a separate document
      for (let i = 0; i < chunks.length; i++) {
        await setDoc(doc(firestore, 'extractedSessions', `${documentId}_chunk_${i}`), {
          documentId,
          chunkIndex: i,
          totalChunks: chunks.length,
          sessions: chunks[i],
          cachedAt: new Date().toISOString()
        });
      }
      
      console.log('✅ Sessions cached in Firestore:', sessions.length, 'weeks in', chunks.length, 'chunks');
    } else {
      // Mobile - store directly
      await db.collection('extractedSessions').doc(documentId).set({
        documentId,
        sessions,
        extractedAt: new Date().toISOString(),
        platform: 'mobile',
      });
    }
  } catch (error) {
    console.warn('⚠️ Firestore session cache failed:', error.message);
  }
}

async getFirestoreCache(documentId) {
  try {
    if (Platform.OS === 'web') {
      const { doc, getDoc, getFirestore } = require('firebase/firestore');
      const firestore = db || getFirestore();
      
      // Get metadata first
      const metaSnap = await getDoc(doc(firestore, 'extractedSessions', documentId));
      
      if (!metaSnap.exists()) {
        return null;
      }
      
      const metadata = metaSnap.data();
      
      // If old format (no chunks), return directly
      if (metadata.sessions) {
        console.log('✅ Using cached sessions (legacy format)');
        return metadata.sessions;
      }
      
      // New format - retrieve all chunks
      const chunksCount = metadata.chunksCount || 0;
      if (chunksCount === 0) {
        return null;
      }
      
      console.log(`Retrieving ${chunksCount} session chunks...`);
      
      const allSessions = [];
      for (let i = 0; i < chunksCount; i++) {
        const chunkSnap = await getDoc(doc(firestore, 'extractedSessions', `${documentId}_chunk_${i}`));
        if (chunkSnap.exists()) {
          const chunkData = chunkSnap.data();
          allSessions.push(...chunkData.sessions);
        }
      }
      
      console.log('✅ Retrieved', allSessions.length, 'weeks from cache');
      return allSessions;
      
    } else {
      // Mobile - direct retrieval
      const docSnap = await db.collection('extractedSessions').doc(documentId).get();
      return docSnap.exists ? docSnap.data().sessions : null;
    }
  } catch (error) {
    console.warn('⚠️ Firestore cache retrieval failed:', error.message);
    return null;
  }
}

  async syncToFirestore(documentId, sessions) {
    setTimeout(() => {
      this.cacheInFirestore(documentId, sessions)
        .catch(err => console.warn('Background sync failed:', err));
    }, 1000);
  }
}

export default new SessionExtractionStrategy();
