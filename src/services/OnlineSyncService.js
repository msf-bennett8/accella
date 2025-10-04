// src/services/OnlineSyncService.js
import { Platform } from 'react-native';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { db } from '../config/firebase.config';
import NetInfo from '@react-native-community/netinfo';

class OnlineSyncService {
  constructor() {
    this.isWeb = Platform.OS === 'web';
    this.isSyncing = false;
    this.syncListeners = new Set();
    this.lastSyncTimestamp = null;
    this.userId = null;
  }

  // ============= INITIALIZATION =============
  
  async initialize(userId) {
    try {
      console.log('🔄 OnlineSyncService: Initializing for user:', userId);
      this.userId = userId;
      
      // Load last sync timestamp
      const lastSync = await AsyncStorage.getItem(`last_sync_${userId}`);
      this.lastSyncTimestamp = lastSync ? new Date(lastSync) : null;
      
      // Setup network listener for auto-sync
      this.setupNetworkListener();
      
      console.log('✅ OnlineSyncService: Initialized successfully');
      return { success: true };
    } catch (error) {
      console.error('❌ OnlineSyncService initialization failed:', error);
      return { success: false, error: error.message };
    }
  }

  setupNetworkListener() {
    NetInfo.addEventListener(state => {
      const isOnline = state.isConnected ?? false;
      
      if (isOnline && !this.isSyncing && this.userId) {
        console.log('📡 Network restored, triggering background sync...');
        setTimeout(() => this.backgroundSync(), 2000);
      }
    });
  }

  // ============= LOGIN SYNC (MAIN ENTRY POINT) =============
  
  async syncOnLogin(userId) {
    try {
      console.log('🔐 OnlineSyncService: Starting login sync for user:', userId);
      this.userId = userId;
      
      const isOnline = await this.checkOnlineStatus();
      if (!isOnline) {
        console.log('📱 Device offline - skipping cloud sync');
        return { success: true, mode: 'offline', synced: false };
      }

      this.isSyncing = true;
      this.emitSyncEvent('sync_started', { userId });

      const results = {
        trainingPlans: { synced: 0, failed: 0 },
        sessions: { synced: 0, failed: 0 },
        documents: { synced: 0, failed: 0 }
      };

      // SYNC TRAINING PLANS
      console.log('📋 Syncing training plans...');
      const plansResult = await this.syncTrainingPlans(userId);
      results.trainingPlans = plansResult;

      // SYNC SESSIONS
      console.log('📅 Syncing sessions...');
      const sessionsResult = await this.syncSessions(userId);
      results.sessions = sessionsResult;

      // SYNC DOCUMENTS METADATA
      console.log('📄 Syncing document metadata...');
      const docsResult = await this.syncDocumentMetadata(userId);
      results.documents = docsResult;

      // Update last sync timestamp
      this.lastSyncTimestamp = new Date();
      await AsyncStorage.setItem(
        `last_sync_${userId}`, 
        this.lastSyncTimestamp.toISOString()
      );

      this.isSyncing = false;
      this.emitSyncEvent('sync_completed', { userId, results });

      console.log('✅ Login sync completed:', results);
      return { success: true, mode: 'online', results };

    } catch (error) {
      console.error('❌ Login sync failed:', error);
      this.isSyncing = false;
      this.emitSyncEvent('sync_error', { userId, error: error.message });
      return { success: false, error: error.message };
    }
  }

  // ============= TRAINING PLANS SYNC =============
  
  async syncTrainingPlans(userId) {
    try {
      // Fetch from Firestore
      const cloudPlans = await this.fetchTrainingPlansFromFirestore(userId);
      console.log(`☁️ Found ${cloudPlans.length} training plans in Firestore`);

      if (this.isWeb) {
        // WEB: Store minimal reference in AsyncStorage, read from Firestore on demand
        await this.storeWebPlanReferences(cloudPlans);
        return { synced: cloudPlans.length, failed: 0, mode: 'web_references' };
      } else {
        // MOBILE: Download full data for offline access
        const localResult = await this.downloadPlansToMobile(cloudPlans);
        return localResult;
      }
    } catch (error) {
      console.error('Training plans sync error:', error);
      return { synced: 0, failed: 1, error: error.message };
    }
  }

  async fetchTrainingPlansFromFirestore(userId) {
    try {
      if (this.isWeb) {
        const { collection, query, where, getDocs } = require('firebase/firestore');
        const plansRef = collection(db, 'trainingPlans');
        const q = query(plansRef, where('userId', '==', userId));
        const snapshot = await getDocs(q);
        
        return snapshot.docs.map(doc => ({
          id: doc.id,
          ...doc.data()
        }));
      } else {
        const snapshot = await db
          .collection('trainingPlans')
          .where('userId', '==', userId)
          .get();
        
        return snapshot.docs.map(doc => ({
          id: doc.id,
          ...doc.data()
        }));
      }
    } catch (error) {
      console.error('Firestore fetch error:', error);
      return [];
    }
  }

  async storeWebPlanReferences(plans) {
    // Web: Store only IDs and essential metadata
    const references = plans.map(plan => ({
      id: plan.id,
      title: plan.title,
      category: plan.category,
      updatedAt: plan.updatedAt,
      sourceDocument: plan.sourceDocument,
      firestoreRef: true // Flag to indicate data is in Firestore
    }));

    await AsyncStorage.setItem('training_plans', JSON.stringify(references));
    console.log('✅ Web: Stored plan references');
  }

  async downloadPlansToMobile(plans) {
    let synced = 0;
    let failed = 0;

    try {
      // Get existing local plans
      const existingPlansJson = await AsyncStorage.getItem('training_plans');
      const existingPlans = existingPlansJson ? JSON.parse(existingPlansJson) : [];

      // Merge with cloud plans (cloud takes precedence)
      const mergedPlans = [...plans];
      
      existingPlans.forEach(localPlan => {
        const existsInCloud = plans.some(p => p.id === localPlan.id);
        if (!existsInCloud) {
          // Keep local-only plans
          mergedPlans.push(localPlan);
        }
      });

      await AsyncStorage.setItem('training_plans', JSON.stringify(mergedPlans));
      synced = plans.length;

      console.log(`✅ Mobile: Downloaded ${synced} plans for offline access`);
      return { synced, failed, mode: 'mobile_offline' };

    } catch (error) {
      console.error('Mobile download error:', error);
      return { synced, failed: failed + 1, error: error.message };
    }
  }

  // ============= SESSIONS SYNC =============
  
  async syncSessions(userId) {
    try {
      // Get all document IDs for this user
      const documents = await this.getUserDocuments(userId);
      console.log(`📄 Found ${documents.length} documents to sync sessions for`);

      let totalSynced = 0;
      let totalFailed = 0;

      for (const doc of documents) {
        const result = await this.syncSessionsForDocument(doc.id);
        totalSynced += result.synced;
        totalFailed += result.failed;
      }

      console.log(`✅ Sessions sync: ${totalSynced} synced, ${totalFailed} failed`);
      return { synced: totalSynced, failed: totalFailed };

    } catch (error) {
      console.error('Sessions sync error:', error);
      return { synced: 0, failed: 1, error: error.message };
    }
  }

  async syncSessionsForDocument(documentId) {
    try {
      // Get metadata first
      const metadata = await this.getSessionMetadata(documentId);
      if (!metadata) {
        return { synced: 0, failed: 0 };
      }

      const { chunksCount } = metadata;
      const allSessions = [];

      // Fetch all chunks
      for (let i = 0; i < chunksCount; i++) {
        const chunk = await this.getSessionChunk(documentId, i);
        if (chunk && chunk.sessions) {
          allSessions.push(...chunk.sessions);
        }
      }

      if (this.isWeb) {
        // Web: Store reference only
        await this.storeWebSessionReference(documentId, metadata);
        return { synced: allSessions.length, failed: 0, mode: 'web_reference' };
      } else {
        // Mobile: Download full session data
        await this.downloadSessionsToMobile(documentId, allSessions);
        return { synced: allSessions.length, failed: 0, mode: 'mobile_offline' };
      }

    } catch (error) {
      console.error(`Session sync error for doc ${documentId}:`, error);
      return { synced: 0, failed: 1, error: error.message };
    }
  }

  async getSessionMetadata(documentId) {
    try {
      if (this.isWeb) {
        const { doc, getDoc } = require('firebase/firestore');
        const metaSnap = await getDoc(doc(db, 'extractedSessions', documentId));
        return metaSnap.exists() ? metaSnap.data() : null;
      } else {
        const metaSnap = await db.collection('extractedSessions').doc(documentId).get();
        return metaSnap.exists ? metaSnap.data() : null;
      }
    } catch (error) {
      console.error('Session metadata fetch error:', error);
      return null;
    }
  }

  async getSessionChunk(documentId, chunkIndex) {
    try {
      if (this.isWeb) {
        const { doc, getDoc } = require('firebase/firestore');
        const chunkSnap = await getDoc(
          doc(db, 'extractedSessions', `${documentId}_chunk_${chunkIndex}`)
        );
        return chunkSnap.exists() ? chunkSnap.data() : null;
      } else {
        const chunkSnap = await db
          .collection('extractedSessions')
          .doc(`${documentId}_chunk_${chunkIndex}`)
          .get();
        return chunkSnap.exists ? chunkSnap.data() : null;
      }
    } catch (error) {
      console.error(`Chunk ${chunkIndex} fetch error:`, error);
      return null;
    }
  }

  async storeWebSessionReference(documentId, metadata) {
    const references = await this.getSessionReferences();
    references[documentId] = {
      totalWeeks: metadata.totalWeeks,
      totalSessions: metadata.totalSessions,
      chunksCount: metadata.chunksCount,
      firestoreRef: true,
      lastSync: new Date().toISOString()
    };

    await AsyncStorage.setItem('session_references', JSON.stringify(references));
  }

  async downloadSessionsToMobile(documentId, sessions) {
    const allSessions = await this.getMobileSessions();
    allSessions[documentId] = {
      sessions,
      downloadedAt: new Date().toISOString()
    };

    await AsyncStorage.setItem('extracted_sessions', JSON.stringify(allSessions));
    console.log(`✅ Downloaded ${sessions.length} sessions for doc ${documentId}`);
  }

  async getSessionReferences() {
    try {
      const refs = await AsyncStorage.getItem('session_references');
      return refs ? JSON.parse(refs) : {};
    } catch (error) {
      return {};
    }
  }

  async getMobileSessions() {
    try {
      const sessions = await AsyncStorage.getItem('extracted_sessions');
      return sessions ? JSON.parse(sessions) : {};
    } catch (error) {
      return {};
    }
  }

  // ============= DOCUMENT METADATA SYNC =============
  
  async syncDocumentMetadata(userId) {
    try {
      const cloudDocs = await this.fetchDocumentsFromFirestore(userId);
      console.log(`☁️ Found ${cloudDocs.length} documents in Firestore`);

      // Store metadata locally
      const existingDocs = await this.getLocalDocuments();
      
      const mergedDocs = cloudDocs.map(cloudDoc => {
        const localDoc = existingDocs.find(d => d.id === cloudDoc.id);
        return {
          ...cloudDoc,
          // Preserve local-only fields if they exist
          webFileData: localDoc?.webFileData,
          localPath: localDoc?.localPath
        };
      });

      await AsyncStorage.setItem('coaching_documents', JSON.stringify(mergedDocs));

      return { synced: cloudDocs.length, failed: 0 };
    } catch (error) {
      console.error('Document metadata sync error:', error);
      return { synced: 0, failed: 1, error: error.message };
    }
  }

  async fetchDocumentsFromFirestore(userId) {
    try {
      if (this.isWeb) {
        const { collection, query, where, getDocs } = require('firebase/firestore');
        const docsRef = collection(db, 'documents');
        const q = query(docsRef, where('userId', '==', userId));
        const snapshot = await getDocs(q);
        
        return snapshot.docs.map(doc => ({
          id: doc.id,
          ...doc.data()
        }));
      } else {
        const snapshot = await db
          .collection('documents')
          .where('userId', '==', userId)
          .get();
        
        return snapshot.docs.map(doc => ({
          id: doc.id,
          ...doc.data()
        }));
      }
    } catch (error) {
      console.error('Firestore documents fetch error:', error);
      return [];
    }
  }

  async getLocalDocuments() {
    try {
      const docs = await AsyncStorage.getItem('coaching_documents');
      return docs ? JSON.parse(docs) : [];
    } catch (error) {
      return [];
    }
  }

  async getUserDocuments(userId) {
    const docs = await this.getLocalDocuments();
    return docs.filter(doc => doc.userId === userId);
  }

  // ============= BACKGROUND SYNC =============
  
  async backgroundSync() {
    if (this.isSyncing || !this.userId) {
      return;
    }

    try {
      console.log('🔄 Background sync started...');
      const result = await this.syncOnLogin(this.userId);
      console.log('✅ Background sync completed:', result);
    } catch (error) {
      console.error('❌ Background sync failed:', error);
    }
  }

  // ============= PUSH TO CLOUD (Upload local changes) =============
  
  async pushLocalChangesToCloud(userId) {
    try {
      console.log('⬆️ Pushing local changes to cloud...');
      
      const plans = await this.getLocalPlans();
      const unsyncedPlans = plans.filter(p => !p.syncedToCloud || p.locallyModified);

      let pushed = 0;
      for (const plan of unsyncedPlans) {
        try {
          await this.uploadPlanToFirestore(plan, userId);
          pushed++;
        } catch (error) {
          console.error('Failed to push plan:', plan.id, error);
        }
      }

      console.log(`✅ Pushed ${pushed} plans to cloud`);
      return { success: true, pushed };
    } catch (error) {
      console.error('Push to cloud failed:', error);
      return { success: false, error: error.message };
    }
  }

  async uploadPlanToFirestore(plan, userId) {
    const planData = {
      ...plan,
      userId,
      syncedToCloud: true,
      lastModified: new Date().toISOString()
    };

    delete planData.locallyModified;

    if (this.isWeb) {
      const { doc, setDoc } = require('firebase/firestore');
      await setDoc(doc(db, 'trainingPlans', plan.id), planData);
    } else {
      await db.collection('trainingPlans').doc(plan.id).set(planData);
    }
  }

  async getLocalPlans() {
    try {
      const plans = await AsyncStorage.getItem('training_plans');
      return plans ? JSON.parse(plans) : [];
    } catch (error) {
      return [];
    }
  }

  // ============= UTILITIES =============
  
  async checkOnlineStatus() {
    try {
      const state = await NetInfo.fetch();
      return state.isConnected ?? false;
    } catch (error) {
      return false;
    }
  }

  addEventListener(callback) {
    this.syncListeners.add(callback);
    return () => this.syncListeners.delete(callback);
  }

  emitSyncEvent(type, data) {
    this.syncListeners.forEach(listener => {
      try {
        listener({ type, data, timestamp: new Date().toISOString() });
      } catch (error) {
        console.warn('Sync listener error:', error);
      }
    });
  }

  async getSyncStatus() {
    return {
      userId: this.userId,
      isSyncing: this.isSyncing,
      lastSync: this.lastSyncTimestamp?.toISOString() || null,
      isOnline: await this.checkOnlineStatus(),
      platform: this.isWeb ? 'web' : 'mobile'
    };
  }
}

export default new OnlineSyncService();