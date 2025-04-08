// Import AsyncStorage and DocumentPicker
import AsyncStorage from '@react-native-async-storage/async-storage';
import * as DocumentPicker from 'expo-document-picker';
import { Audio, InterruptionModeAndroid, InterruptionModeIOS, ResizeMode, Video } from 'expo-av';
import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
    ActivityIndicator,
    Alert,
    AppState,
    Button,
    Dimensions,
    FlatList, Image,
    Modal,
    Platform,
    RefreshControl,
    SafeAreaView,
    ScrollView,
    StyleSheet,
    Text,
    TextInput,
    TouchableOpacity,
    View
} from 'react-native';
// --- Navigation ---
// Import Stack Navigator for Playlist Details
import { NavigationContainer, useIsFocused, useNavigation } from '@react-navigation/native';
import { createBottomTabNavigator } from '@react-navigation/bottom-tabs';
import { createNativeStackNavigator } from '@react-navigation/native-stack'; // <-- ADD STACK NAVIGATOR
// --- Icons ---
import { Ionicons, MaterialIcons } from '@expo/vector-icons';
// --- idb for web ONLY ---
import { GoogleGenerativeAI } from "@google/genai";
import Slider from '@react-native-community/slider';
import * as MediaLibrary from 'expo-media-library';
import { openDB } from 'idb'; // Import idb
import ImageViewer from 'react-native-image-zoom-viewer';

// --- Constants ---
const { width, height } = Dimensions.get('window');
const MINI_PLAYER_HEIGHT = 65;
const TAB_BAR_HEIGHT = 55; // Standard approx height
// WARNING: EXPOSING API KEYS IN CLIENT-SIDE CODE IS A MAJOR SECURITY RISK!
// These should be handled via a backend server or secure environment variables in a real application.
const GEMINI_API_KEY = "AIzaSyDtzOBprQ3AvPrtieLJJjVf69X_PkotWT4"; // <--- EXPOSED! Replace with secure method if deploying
const SPOTIFY_CLIENT_ID = "204c3d96e9d14d678ce142499ccaa83e"; // <--- EXPOSED! Replace with secure method if deploying
const SPOTIFY_CLIENT_SECRET = "02dab7bb62a4487e9c0a997fcf827d3a"; // <--- EXPOSED! Replace with secure method if deploying
// END WARNING
const GEMINI_MODEL_NAME = "gemini-1.5-pro";
const SPOTIFY_TOKEN_URL = 'https://accounts.spotify.com/api/token';
const SPOTIFY_SEARCH_URL = 'https://api.spotify.com/v1/search';
const DB_NAME = "mediaLibraryDB_v7_playlists"; // <-- Incremented DB version
const DB_VERSION = 4; // <-- Incremented DB version
const STORE_NAME = 'media';
const PLAYLIST_STORE_NAME = 'playlists'; // <-- New store for playlists
const ASYNC_STORAGE_FAVORITES_KEY = '@MediaApp:favoriteIds'; // <-- Key for native favorites
const ASYNC_STORAGE_PLAYLISTS_KEY = '@MediaApp:playlists'; // <-- Key for native playlists
const SLIDESHOW_INTERVAL = 3000;
const EQ_BANDS = [ // Define EQ bands (frequency, type, default Q)
    { freq: 60, type: 'lowshelf', Q: 1 },
    { freq: 230, type: 'peaking', Q: 1.5 },
    { freq: 910, type: 'peaking', Q: 1.5 },
    { freq: 3600, type: 'peaking', Q: 1.5 },
    { freq: 14000, type: 'highshelf', Q: 1 }
];
const BACKGROUND_METADATA_FETCH_DELAY = 1500; // ms delay between Spotify fetches
const METADATA_LOAD_TIMEOUT = 5000; // ms timeout for loading audio/video duration

// --- Initialize APIs ---
let genAI;
// Check if the key is present and not the placeholder or the example key (adjust if needed)
if (GEMINI_API_KEY && GEMINI_API_KEY !== "YOUR_API_KEY_HERE" && GEMINI_API_KEY !== "AIzaSyDtzOBprQ3AvPrtieLJJjVf69X_PkotWT4") {
    try {
        genAI = new GoogleGenerativeAI(GEMINI_API_KEY);
        console.log("Gemini AI Initialized.");
    } catch (error) {
        console.error("Failed to initialize Gemini AI:", error);
    }
} else {
    console.warn("Gemini API Key is missing, placeholder, or the example key! Gemini features disabled.");
}

// --- Database Setup (idb for Web ONLY) ---
let dbPromise = null; // Initialize as null

function openDatabase() {
    if (Platform.OS === "web") {
        if (!dbPromise) { // Only create promise if it doesn't exist
            console.log("Initializing IndexedDB (idb)...");
            dbPromise = openDB(DB_NAME, DB_VERSION, {
                upgrade(db, oldVersion, newVersion, transaction) {
                    console.log(`Upgrading DB from version ${oldVersion} to ${newVersion}`);
                    let mediaStore;
                    if (!db.objectStoreNames.contains(STORE_NAME)) {
                        console.log(`Creating object store: ${STORE_NAME}`);
                        mediaStore = db.createObjectStore(STORE_NAME, { keyPath: 'id', autoIncrement: true });
                        mediaStore.createIndex('uri_idx', 'uri', { unique: true });
                        mediaStore.createIndex('name_idx', 'name');
                        mediaStore.createIndex('artistName_idx', 'artistName');
                        mediaStore.createIndex('albumName_idx', 'albumName');
                        mediaStore.createIndex('addedDate_idx', 'addedDate');
                        mediaStore.createIndex('type_idx', 'type');
                        console.log(`Base indexes created for ${STORE_NAME}`);
                    } else {
                        // Get existing store within the transaction
                        mediaStore = transaction.objectStore(STORE_NAME);
                        console.log(`Object store ${STORE_NAME} already exists.`);
                    }
                    // Apply upgrades incrementally for media store
                    if (oldVersion < 2) {
                        console.log("Applying upgrade to version 2: Adding isFavorite field and index");
                        if (!mediaStore.indexNames.contains('isFavorite_idx')) {
                            mediaStore.createIndex('isFavorite_idx', 'isFavorite');
                            console.log("Created isFavorite_idx index.");
                        }
                    }
                    if (oldVersion < 3) {
                        console.log("Applying upgrade to version 3: Adding lastPlayed and spotifyChecked fields/indexes");
                        if (!mediaStore.indexNames.contains('lastPlayed_idx')) {
                            mediaStore.createIndex('lastPlayed_idx', 'lastPlayed');
                            console.log("Created lastPlayed_idx index.");
                        }
                        if (!mediaStore.indexNames.contains('spotifyChecked_idx')) {
                             mediaStore.createIndex('spotifyChecked_idx', 'spotifyChecked');
                             console.log("Created spotifyChecked_idx index.");
                        }
                    }
                    // Apply upgrades for playlist store (New in v4)
                    if (oldVersion < 4) {
                        console.log("Applying upgrade to version 4: Adding playlists store");
                        if (!db.objectStoreNames.contains(PLAYLIST_STORE_NAME)) {
                            console.log(`Creating object store: ${PLAYLIST_STORE_NAME}`);
                            const playlistStore = db.createObjectStore(PLAYLIST_STORE_NAME, { keyPath: 'id', autoIncrement: true });
                            playlistStore.createIndex('name_idx', 'name'); // Index for searching/sorting by name
                            console.log(`Indexes created for ${PLAYLIST_STORE_NAME}`);
                        } else {
                            console.log(`Object store ${PLAYLIST_STORE_NAME} already exists.`);
                        }
                    }
                    console.log("DB Upgrade complete.");
                },
                blocked() {
                    console.error("IndexedDB Blocked: Another tab might be open with an older version.");
                    Alert.alert("Database Error", "Cannot open database. Please close other tabs running this app and reload.");
                },
                blocking() {
                    console.warn("IndexedDB Blocking: This tab is blocking other tabs from upgrading.");
                },
                terminated() {
                    console.warn("IndexedDB Terminated: Connection was closed unexpectedly.");
                    dbPromise = null; // Reset promise so it can be reopened
                }
            });
            dbPromise.then(() => console.log("IndexedDB connection established."))
                     .catch(err => {
                         console.error("IndexedDB open error:", err);
                         dbPromise = null; // Reset on error
                         Alert.alert("Database Error", `Failed to open database: ${err.message}`);
                     });
        }
        return dbPromise;
    } else {
        // console.warn("IndexedDB is web-only. Database functionality disabled on native platforms.");
        return Promise.resolve(null); // Resolve with null for native platforms
    }
}

// Call openDatabase early to start the process
const dbInstancePromise = openDatabase();

// --- Helper Functions ---
const getFileType = (uriOrNameOrMime) => {
    const name = typeof uriOrNameOrMime === 'string' ? uriOrNameOrMime : uriOrNameOrMime?.name || '';
    const mime = typeof uriOrNameOrMime === 'string' ? null : uriOrNameOrMime?.mimeType; // Get mimeType if object provided

    if (mime) {
        if (mime.startsWith('audio/')) return 'audio';
        if (mime.startsWith('video/')) return 'video';
        if (mime.startsWith('image/')) return 'image';
        if (mime === 'application/pdf' || mime.startsWith('application/msword') || mime.startsWith('application/vnd.openxmlformats-officedocument.wordprocessingml') || mime === 'text/plain' || mime.startsWith('application/vnd.ms-excel') || mime.startsWith('application/vnd.openxmlformats-officedocument.spreadsheetml') || mime.startsWith('application/vnd.ms-powerpoint') || mime.startsWith('application/vnd.openxmlformats-officedocument.presentationml') || mime === 'text/rtf' || mime === 'text/csv') return 'document';
        if (mime === 'application/lrc' || mime === 'text/lrc') return 'lyrics'; // Check mime for LRC too
    }

    // Fallback to extension if mime type didn't match or wasn't provided
    const extension = name?.split('.').pop()?.toLowerCase();
    if (!extension) return 'unknown';
    if (['mp3', 'wav', 'm4a', 'aac', 'ogg', 'flac'].includes(extension)) return 'audio';
    if (['mp4', 'mov', 'avi', 'mkv', 'webm', '3gp'].includes(extension)) return 'video';
    if (['jpg', 'jpeg', 'png', 'gif', 'bmp', 'webp'].includes(extension)) return 'image';
    if (['pdf', 'doc', 'docx', 'txt', 'xls', 'xlsx', 'ppt', 'pptx', 'rtf', 'csv'].includes(extension)) return 'document';
    if (['lrc'].includes(extension)) return 'lyrics';
    return 'unknown';
};


const formatTime = (millis) => {
    if (millis == null || !Number.isFinite(millis) || millis < 0) return '0:00'; // Check for null/undefined too
    const totalSeconds = Math.floor(millis / 1000);
    const seconds = totalSeconds % 60;
    const minutes = Math.floor(totalSeconds / 60);
    return `${minutes}:${seconds < 10 ? '0' : ''}${seconds}`;
};

const cleanFilenameForSearch = (filename) => {
    if (!filename) return '';
    let decodedName = filename;
    try { decodedName = decodeURIComponent(filename); } catch (e) { console.warn("URI Malformed, using original:", filename); }
    let name = decodedName.substring(0, decodedName.lastIndexOf('.')) || decodedName; // Use decodedName
    // More aggressive cleaning, remove things within brackets/parentheses, common terms, special chars
    name = name.replace(/\[.*?\]|\(.*?\)|{.*?}|_|-|\.mp3|\.flac|\.wav|\.m4a|\.mp4|official music video|official video|lyrics video|lyric video|hd|4k|720p|1080p|audio|video|ft\.|feat\./gi, ' ').trim();
    name = name.replace(/[^\p{L}\p{N}\s'-]/gu, ''); // Keep letters, numbers, spaces, apostrophe, hyphen
    name = name.replace(/\s+/g, ' ').trim(); // Collapse multiple spaces
    name = name.replace(/^\d+\s*[\.\-]?\s*/, '').trim(); // Remove leading track numbers
    return name;
};

const downloadBlobUri = (uri, filename) => {
    if (Platform.OS !== 'web' || !uri || !uri.startsWith('blob:')) {
        console.warn("Download only available for blob URIs on web.");
        Alert.alert("Download Not Available", "This file cannot be downloaded directly on this platform.");
        return;
    }
    try {
        const link = document.createElement('a');
        link.href = uri;
        link.download = filename || 'download';
        document.body.appendChild(link);
        link.click();
        document.body.removeChild(link);
        console.log(`Initiated download for: ${filename}`);
    } catch (error) {
        console.error("Download Error:", error);
        Alert.alert("Download Failed", "Could not initiate download.");
    }
};

const mapAssetType = (mediaType) => {
    if (mediaType === MediaLibrary.MediaType.audio) return 'audio';
    if (mediaType === MediaLibrary.MediaType.video) return 'video';
    if (mediaType === MediaLibrary.MediaType.photo) return 'image';
    return 'unknown';
};

// Generate a simple unique ID (for native items/playlists where DB doesn't provide one)
const generateUniqueId = () => `id_${Date.now()}_${Math.random().toString(36).substring(2, 9)}`;

// --- Reusable Components ---

// --- MediaListItem ---
const MediaListItem = React.memo(({ item, isCurrent, isPlaying, isLoadingMeta, onPress, onLongPress, isFavorite, showTypeIcon = true }) => {
    const icon = useMemo(() => {
        if (!showTypeIcon) return null;
        switch (item.type) {
            case 'audio': return <Ionicons name="musical-notes" size={20} color="#aaa" style={styles.itemTypeIcon} />;
            case 'video': return <Ionicons name="videocam" size={20} color="#aaa" style={styles.itemTypeIcon} />;
            case 'image': return <Ionicons name="image" size={20} color="#aaa" style={styles.itemTypeIcon} />;
            case 'document': return <Ionicons name="document-text" size={20} color="#aaa" style={styles.itemTypeIcon} />;
            case 'lyrics': return <MaterialIcons name="lyrics" size={20} color="#aaa" style={styles.itemTypeIcon} />;
            default: return <Ionicons name="help-circle" size={20} color="#aaa" style={styles.itemTypeIcon} />;
        }
    }, [item.type, showTypeIcon]);

    const placeholder = require('../assets/placeholder.png'); // Ensure path is correct

    const imageSource = useMemo(() => {
        let uri = item.coverArtUrl || (item.type === 'image' ? item.uri : null);
        // Blob URIs are generally fine on web, but might cause issues if passed to native Image
        // Keep this check for safety, although coverArtUrl is usually http/https
        if (uri && uri.startsWith('blob:') && Platform.OS !== 'web') {
            console.warn(`Blob URI found on non-web platform for image source: ${uri}. Clearing.`);
            uri = null;
        }
        return uri ? { uri: uri } : placeholder;
    }, [item.coverArtUrl, item.uri, item.type]);


    return (
        <TouchableOpacity
            style={[styles.itemContainer, isCurrent && styles.itemContainerCurrent]}
            onPress={() => onPress(item)}
            onLongPress={() => onLongPress(item)}
            disabled={isLoadingMeta} // Disable press while metadata is loading
        >
            <Image
                source={imageSource}
                style={styles.itemThumbnail}
                onError={(e) => console.warn(`Image load error for ${imageSource.uri || 'placeholder'}: ${e.nativeEvent?.error || 'Unknown error'}`)}
                defaultSource={placeholder} // Use defaultSource for better loading experience
            />
            <View style={styles.itemTextContainer}>
                <Text style={styles.itemTitle} numberOfLines={1}>{item.trackName || item.name || 'Unknown Track'}</Text>
                <Text style={styles.itemSubtitle} numberOfLines={1}>
                    {item.artistName ? `${item.artistName}${item.albumName ? ` • ${item.albumName}` : ''}` : (item.type || 'Unknown Type')}
                </Text>
            </View>
            <View style={styles.itemRightContainer}>
                 {isFavorite && ( // Show heart for favorites on both platforms now
                    <Ionicons name="heart" size={18} color="#1DB954" style={styles.itemFavoriteIcon} />
                 )}
                {isLoadingMeta && <ActivityIndicator size="small" color="#1DB954" style={styles.itemActivityIndicator} />}
                {isCurrent && isPlaying
                    ? <Ionicons name="volume-medium" size={20} color="#1DB954" style={styles.itemPlayingIndicator} />
                    : (item.durationMillis != null && item.type !== 'image' && item.type !== 'document' && item.type !== 'lyrics' && // Check duration is not null
                        <Text style={styles.itemDuration}>{formatTime(item.durationMillis)}</Text>)
                }
                {icon}
            </View>
        </TouchableOpacity>
    );
});

// --- SearchBarComponent ---
const SearchBarComponent = ({ isSearching, searchQuery, onToggleSearch, onSearchChange, onClearSearch }) => {
    if (!isSearching) return null;
    return (
        <View style={styles.searchBarContainer}>
            <TouchableOpacity onPress={onToggleSearch} style={styles.searchBarIcon}>
                <Ionicons name="arrow-back" size={24} color="white" />
            </TouchableOpacity>
            <TextInput
                style={styles.searchInput}
                placeholder="Search Library..."
                placeholderTextColor="#888"
                value={searchQuery}
                onChangeText={onSearchChange}
                autoFocus
                returnKeyType="search"
                clearButtonMode="while-editing" // iOS only
            />
            {searchQuery.length > 0 && (
                <TouchableOpacity onPress={onClearSearch} style={styles.searchBarIcon}>
                    {Platform.OS === 'web' ? <MaterialIcons name="clear" size={20} color="#888" /> : <Ionicons name="close-circle" size={20} color="#888" />}
                </TouchableOpacity>
            )}
        </View>
    );
};

// --- LyricsViewer ---
const LyricsViewer = ({ isVisible, isLoading, lyrics, trackName, onClose, onFetch }) => (
    <Modal animationType="slide" transparent visible={isVisible} onRequestClose={onClose}>
        <SafeAreaView style={styles.modalContainer}>
            {/* Allow closing by tapping outside */}
            <TouchableOpacity style={StyleSheet.absoluteFill} onPress={onClose} activeOpacity={1} />
            <View style={styles.modalContent}>
                <View style={styles.modalHeader}>
                    <Text style={styles.modalTitle} numberOfLines={1}>{trackName || 'Lyrics & Chords'}</Text>
                    <TouchableOpacity onPress={onClose}><Ionicons name="close" size={28} color="#ccc" /></TouchableOpacity>
                </View>
                <ScrollView style={styles.lyricsScrollView} contentContainerStyle={styles.lyricsScrollContent}>
                    {isLoading ? (
                        <View style={styles.loadingOverlayModal}>
                            <ActivityIndicator size="large" color="#1DB954" />
                            <Text style={styles.loadingText}>Fetching Lyrics...</Text>
                        </View>
                    ) : (
                        <Text style={styles.lyricsText} selectable>{lyrics || 'No lyrics/chords available for this track.'}</Text>
                    )}
                </ScrollView>
                {/* Show Fetch button only if Gemini is available, not loading, no lyrics found, and onFetch provided */}
                {!isLoading && !lyrics && onFetch && genAI && Platform.OS === 'web' && (
                    <View style={styles.modalButtonContainer}>
                        <Button title="Fetch Lyrics/Chords (Online)" onPress={onFetch} color="#1DB954" disabled={isLoading} />
                    </View>
                )}
                 <View style={styles.modalButtonContainer}>
                    <Button title="Close" onPress={onClose} color="#555" />
                 </View>
            </View>
        </SafeAreaView>
    </Modal>
);

// --- FullScreenPlayer ---
const FullScreenPlayer = ({
    isVisible, media, playbackStatus, isLoading, isFetchingLyrics, lyrics,
    volume, rate, isLooping,
    eqGains,
    onClose, onPlayPause, onSeek, onShowLyrics,
    onVolumeChange, onRateChange, onLoopToggle,
    onNextTrack, onPreviousTrack,
    onEqGainChange,
    onResetEq,
    hasNext, hasPrevious
}) => {
    if (!isVisible || !media) return null;

    const [showEq, setShowEq] = useState(false);
    const isPlaying = playbackStatus?.isPlaying ?? false;
    const duration = playbackStatus?.durationMillis ?? media.durationMillis ?? 0;
    const position = playbackStatus?.positionMillis ?? 0;
    const canSeek = playbackStatus?.isLoaded && duration > 0 && Number.isFinite(duration);
    const isVideo = media.type === 'video';
    const videoRef = useRef(null); // Ref for native Video component
    const placeholder = require('../assets/placeholder.png'); // Ensure path is correct

    const handleSlidingComplete = (value) => { if (canSeek && typeof value === 'number') onSeek(value); };

    // Reset EQ visibility when player is hidden or media changes
    useEffect(() => {
        if (!isVisible || !media) {
            setShowEq(false);
        }
    }, [isVisible, media]);

    // Rate display text
    const rateText = useMemo(() => {
        const rates = [0.75, 1.0, 1.25, 1.5, 2.0];
        const closestRate = rates.find(r => Math.abs(r - rate) < 0.01);
        return closestRate ? `${closestRate.toFixed(2)}x`.replace('.00', '') : `${rate.toFixed(1)}x`;
    }, [rate]);

    // Determine image source
    const imageSource = useMemo(() => {
        let uri = media.coverArtUrl;
        if (uri && uri.startsWith('blob:') && Platform.OS !== 'web') {
            uri = null; // Avoid blob URIs for native Image
        }
        return uri ? { uri: uri } : placeholder;
    }, [media.coverArtUrl]);

    return (
        <Modal animationType="slide" visible={isVisible} onRequestClose={onClose} statusBarTranslucent>
            <SafeAreaView style={styles.fullPlayerContainer}>
                 {/* Native Video Player - Render only on native */}
                 {isVideo && media.uri && Platform.OS !== 'web' && (
                    <Video
                        ref={videoRef}
                        style={styles.fullPlayerVideo}
                        source={{ uri: media.uri }}
                        useNativeControls={false} // We use custom controls
                        resizeMode={ResizeMode.CONTAIN}
                        onError={(e) => console.error("Full Screen Video Error (Native):", e)}
                        progressUpdateIntervalMillis={500}
                        // Playback state is controlled by the main playbackInstance via App component
                        shouldPlay={playbackStatus?.isPlaying}
                        volume={volume}
                        rate={rate}
                        isLooping={isLooping}
                        // Note: Seeking needs to be handled via playbackInstance.setPositionAsync
                        // This component primarily displays the video frame.
                    />
                 )}
                 {/* Web Video Player - Rendered via WebAudioPlayer component */}
                 {isVideo && Platform.OS === 'web' && (
                     <video
                         id="web-video-player-element" // Use same ID as audio for simplicity? Or different? Let's use audio ID.
                         style={styles.fullPlayerVideoWeb} // Use different style if needed
                         src={media.uri}
                         preload="metadata"
                         crossOrigin="anonymous"
                         // Controls managed by WebAudioPlayer logic
                     />
                 )}


                <View style={styles.fullPlayerHeader}>
                    <TouchableOpacity onPress={onClose} style={styles.fullPlayerCloseButton}>
                        <Ionicons name="chevron-down" size={30} color="white" />
                    </TouchableOpacity>
                    <Text style={styles.fullPlayerHeaderText} numberOfLines={1}>{media.albumName || ' '}</Text>
                    <TouchableOpacity onPress={onRateChange} style={styles.fullPlayerHeaderButton}>
                        <Text style={styles.fullPlayerRateText}>{rateText}</Text>
                    </TouchableOpacity>
                </View>

                {/* Artwork Area (Hide if video is playing) */}
                {!isVideo ? (
                    <View style={styles.fullPlayerArtContainer}>
                        <Image
                            source={imageSource}
                            style={styles.fullPlayerArt}
                            resizeMode="contain"
                            defaultSource={placeholder}
                        />
                    </View>
                ) : (
                    // Provide space even when video is showing for layout consistency
                    <View style={styles.fullPlayerArtContainerPlaceholder} />
                )}

                <View style={styles.fullPlayerInfoContainer}>
                    <Text style={styles.fullPlayerTitle} numberOfLines={1}>{media.trackName || media.name || 'Unknown Track'}</Text>
                    <Text style={styles.fullPlayerArtist} numberOfLines={1}>{media.artistName || 'Unknown Artist'}</Text>
                </View>

                <View style={styles.fullPlayerProgressContainer}>
                    <Slider
                        style={styles.fullPlayerSlider}
                        minimumValue={0}
                        maximumValue={canSeek ? duration : 1} // Use 1 as max if duration unknown
                        value={canSeek ? position : 0}
                        minimumTrackTintColor="#1DB954"
                        maximumTrackTintColor="#555"
                        thumbTintColor="#FFFFFF"
                        onSlidingComplete={handleSlidingComplete}
                        disabled={!canSeek || isLoading}
                    />
                    <View style={styles.fullPlayerTimeContainer}>
                        <Text style={styles.fullPlayerTimeText}>{formatTime(position)}</Text>
                        <Text style={styles.fullPlayerTimeText}>{formatTime(duration)}</Text>
                    </View>
                </View>

                <View style={styles.fullPlayerControlsContainer}>
                    {/* Shuffle Button (Placeholder/Disabled) */}
                    <TouchableOpacity style={styles.fullPlayerControlButton} disabled>
                         <Ionicons name="shuffle" size={24} color="#888" />
                    </TouchableOpacity>
                    <TouchableOpacity style={styles.fullPlayerControlButton} onPress={onPreviousTrack} disabled={!hasPrevious || isLoading}>
                        <Ionicons name="play-skip-back" size={30} color={hasPrevious ? "white" : "#888"} />
                    </TouchableOpacity>
                    <TouchableOpacity style={styles.fullPlayerPlayPauseButton} onPress={onPlayPause} disabled={isLoading || (playbackStatus && !playbackStatus.isLoaded && !playbackStatus.error)}>
                        {/* Show buffering indicator */}
                        {isLoading || playbackStatus?.isBuffering
                            ? <ActivityIndicator size="large" color="white" />
                            : <Ionicons name={isPlaying ? "pause-circle" : "play-circle"} size={70} color="white" />
                        }
                    </TouchableOpacity>
                    <TouchableOpacity style={styles.fullPlayerControlButton} onPress={onNextTrack} disabled={!hasNext || isLoading}>
                        <Ionicons name="play-skip-forward" size={30} color={hasNext ? "white" : "#888"} />
                    </TouchableOpacity>
                    <TouchableOpacity style={styles.fullPlayerControlButton} onPress={onLoopToggle}>
                        <Ionicons name="repeat" size={24} color={isLooping ? "#1DB954" : "white"} />
                    </TouchableOpacity>
                </View>

                <View style={styles.fullPlayerBottomActions}>
                     {/* Lyrics Button (Web Audio Only) */}
                     {media?.type === 'audio' && Platform.OS === 'web' && genAI ? (
                        <TouchableOpacity onPress={onShowLyrics} style={styles.fullPlayerActionButton} disabled={isFetchingLyrics}>
                            {isFetchingLyrics
                                ? <ActivityIndicator size="small" color="white" />
                                : <MaterialIcons name="lyrics" size={24} color="white" />
                            }
                            <Text style={styles.fullPlayerActionButtonText}>Lyrics</Text>
                        </TouchableOpacity>
                    ) : <View style={styles.fullPlayerActionButtonPlaceholder}/> }

                     <View style={styles.volumeControlContainer}>
                         <Ionicons name="volume-low" size={20} color="#aaa" style={{ marginRight: 5 }}/>
                         <Slider
                             style={styles.volumeSlider}
                             minimumValue={0}
                             maximumValue={1}
                             value={volume}
                             minimumTrackTintColor="#FFF"
                             maximumTrackTintColor="#555"
                             thumbTintColor="#FFF"
                             onValueChange={onVolumeChange} // Use onValueChange for continuous update
                             disabled={isLoading}
                         />
                         <Ionicons name="volume-high" size={20} color="#aaa" style={{ marginLeft: 5 }}/>
                     </View>

                    {/* EQ Button (Audio Only) */}
                    {media?.type === 'audio' ? (
                        <TouchableOpacity onPress={() => setShowEq(!showEq)} style={styles.fullPlayerActionButton}>
                            <Ionicons name="options-outline" size={24} color={showEq ? "#1DB954" : "white"} />
                            <Text style={[styles.fullPlayerActionButtonText, showEq && { color: "#1DB954" }]}>EQ</Text>
                        </TouchableOpacity>
                    ) : <View style={styles.fullPlayerActionButtonPlaceholder} /> }
                </View>

                {/* EQ Section */}
                {showEq && media?.type === 'audio' && (
                    <View style={styles.eqContainer}>
                        <View style={styles.eqHeader}>
                            <Text style={styles.eqTitle}>Equalizer</Text>
                            <Button title="Reset" onPress={onResetEq} color="#888" />
                        </View>
                        {/* Note about EQ platform limitation */}
                        {Platform.OS !== 'web' && (
                            <Text style={styles.eqNote}>(Note: EQ controls are UI only on this platform)</Text>
                        )}
                        <View style={styles.eqSlidersContainer}>
                            {EQ_BANDS.map((band, index) => (
                                <View key={band.freq} style={styles.eqSliderWrapper}>
                                    <Text style={styles.eqBandLabel}>{band.freq < 1000 ? `${band.freq}Hz` : `${(band.freq / 1000).toFixed(1)}kHz`}</Text>
                                    <Slider
                                        style={styles.eqSlider}
                                        minimumValue={-12}
                                        maximumValue={12}
                                        step={1}
                                        value={eqGains[index] ?? 0}
                                        minimumTrackTintColor="#1DB954"
                                        maximumTrackTintColor="#555"
                                        thumbTintColor="#FFFFFF"
                                        onValueChange={(value) => onEqGainChange(index, value)} // Use onValueChange
                                        disabled={Platform.OS !== 'web'} // Disable slider if not on web
                                    />
                                    <Text style={styles.eqGainLabel}>{`${(eqGains[index] ?? 0).toFixed(0)}dB`}</Text>
                                </View>
                            ))}
                        </View>
                    </View>
                )}
            </SafeAreaView>
        </Modal>
    );
};

// --- Mini Player Bar ---
const MiniPlayerBar = ({ currentMedia, playbackStatus, isLoading, onPlayPause, onExpandPlayer }) => {
    // Only show for playable media types
    if (!currentMedia || ['image', 'document', 'lyrics', 'unknown'].includes(currentMedia.type)) return null;

    const isPlaying = playbackStatus?.isPlaying ?? false;
    const duration = playbackStatus?.durationMillis ?? currentMedia.durationMillis ?? 0;
    const position = playbackStatus?.positionMillis ?? 0;
    const progress = (duration > 0 && Number.isFinite(duration) && Number.isFinite(position))
                     ? Math.max(0, Math.min(1, position / duration))
                     : 0;
    const placeholder = require('../assets/placeholder.png'); // Ensure path is correct

    // Determine image source
    const imageSource = useMemo(() => {
        let uri = currentMedia.coverArtUrl;
        if (uri && uri.startsWith('blob:') && Platform.OS !== 'web') {
            uri = null; // Avoid blob URIs for native Image
        }
        return uri ? { uri: uri } : placeholder;
    }, [currentMedia.coverArtUrl]);

    return (
        <TouchableOpacity style={styles.playerBarContainer} onPress={onExpandPlayer} activeOpacity={0.8}>
            {/* Progress Line */}
            <View style={styles.playerProgressLineBackground}>
                <View style={[styles.playerProgressLineForeground, { width: `${progress * 100}%` }]} />
            </View>
            <View style={styles.playerBarContent}>
                <Image
                    source={imageSource}
                    style={styles.playerThumbnail}
                    defaultSource={placeholder}
                />
                <View style={styles.playerInfo}>
                    <Text style={styles.playerTitle} numberOfLines={1}>{currentMedia.trackName || currentMedia.name || 'Unknown Track'}</Text>
                    <Text style={styles.playerSubtitle} numberOfLines={1}>{currentMedia.artistName || ' '}</Text>
                </View>
                <TouchableOpacity
                    onPress={(e) => { e.stopPropagation(); onPlayPause(); }} // Prevent expand on button press
                    style={styles.playerControl}
                    // Disable if loading, or if status exists but isn't loaded and has no error
                    disabled={isLoading || (playbackStatus && !playbackStatus.isLoaded && !playbackStatus.error)}
                >
                    {/* Show buffering/loading indicator */}
                    {(isLoading && currentMedia?.id === currentMedia?.id) || playbackStatus?.isBuffering
                        ? <ActivityIndicator size="small" color="white" />
                        : <Ionicons name={isPlaying ? 'pause' : 'play'} size={30} color="white" />
                    }
                </TouchableOpacity>
            </View>
        </TouchableOpacity>
    );
};

// --- Image Viewer Modal ---
const ImageViewerModal = ({ isVisible, images, initialIndex, onClose, onIndexChanged }) => {
    const [currentIndex, setCurrentIndex] = useState(initialIndex);
    const [isSlideshowActive, setIsSlideshowActive] = useState(false);
    const slideshowIntervalRef = useRef(null);

    // Reset index when modal becomes visible with a new initialIndex
    useEffect(() => {
        if (isVisible) {
            setCurrentIndex(initialIndex);
        }
    }, [isVisible, initialIndex]);

    // Cleanup slideshow interval
    useEffect(() => {
        // Stop slideshow if modal is closed or component unmounts
        if (!isVisible) {
            stopSlideshow();
        }
        return () => stopSlideshow(); // Cleanup on unmount
    }, [isVisible]);

    const handleIndexChange = (index) => {
        if (index !== currentIndex) { // Prevent updates if index hasn't changed
            setCurrentIndex(index);
            if (onIndexChanged) {
                onIndexChanged(index);
            }
        }
    };

    const startSlideshow = useCallback(() => {
        if (slideshowIntervalRef.current || !images || images.length <= 1) return;
        setIsSlideshowActive(true);
        console.log("Starting slideshow");
        slideshowIntervalRef.current = setInterval(() => {
            // Use functional update for setCurrentIndex
            setCurrentIndex(prevIndex => {
                const nextIndex = (prevIndex + 1) % images.length;
                // Call onIndexChanged *after* state update is scheduled
                if (onIndexChanged) {
                    // Schedule the call slightly after state update to ensure viewer syncs
                    requestAnimationFrame(() => onIndexChanged(nextIndex));
                }
                return nextIndex;
            });
        }, SLIDESHOW_INTERVAL);
    }, [images, onIndexChanged]); // Add dependencies

    const stopSlideshow = useCallback(() => {
        if (slideshowIntervalRef.current) {
            console.log("Stopping slideshow");
            clearInterval(slideshowIntervalRef.current);
            slideshowIntervalRef.current = null;
            setIsSlideshowActive(false);
        }
    }, []); // No dependencies needed

    const toggleSlideshow = useCallback(() => {
        if (isSlideshowActive) {
            stopSlideshow();
        } else {
            startSlideshow();
        }
    }, [isSlideshowActive, startSlideshow, stopSlideshow]); // Add dependencies

    // Format images for the viewer library
    const formattedImages = useMemo(() => images.map(img => ({
        url: img.uri, // uri should be the primary source
        props: { source: { uri: img.uri } }, // Pass source prop for potential customization
        id: img.id,
        name: img.name,
    })), [images]);

    if (!isVisible || !formattedImages || formattedImages.length === 0) return null;

    const currentImageName = formattedImages[currentIndex]?.name || '';

    return (
        <Modal visible={isVisible} transparent={true} onRequestClose={onClose} statusBarTranslucent>
            <SafeAreaView style={styles.imageViewerSafeArea}>
                <ImageViewer
                    imageUrls={formattedImages}
                    index={currentIndex}
                    onChange={handleIndexChange}
                    enableSwipeDown={true}
                    onSwipeDown={onClose} // Close on swipe down
                    renderHeader={() => (
                        <View style={styles.imageViewerHeader}>
                            <TouchableOpacity onPress={onClose} style={styles.imageViewerButton}>
                                <Ionicons name="close" size={30} color="white" />
                            </TouchableOpacity>
                            <Text style={styles.imageViewerTitle} numberOfLines={1}>{currentImageName}</Text>
                            <TouchableOpacity onPress={toggleSlideshow} style={styles.imageViewerButton} disabled={images.length <= 1}>
                                <Ionicons name={isSlideshowActive ? "pause" : "play"} size={26} color={images.length <= 1 ? "#888" : "white"} />
                            </TouchableOpacity>
                        </View>
                    )}
                    renderIndicator={(currentShownIndex, totalCount) => ( // Use correct prop names
                        totalCount > 1 ? (
                            <View style={styles.imageViewerIndicator}>
                                {/* Use currentShownIndex which reflects the displayed image */}
                                <Text style={styles.imageViewerIndicatorText}>{`${currentShownIndex + 1} / ${totalCount}`}</Text>
                            </View>
                        ) : null
                    )}
                    loadingRender={() => <ActivityIndicator size="large" color="white" />}
                    enablePreload // Preload adjacent images
                    saveToLocalByLongPress={false} // Disable default save action
                />
            </SafeAreaView>
        </Modal>
    );
};

// --- AddToPlaylistModal ---
const AddToPlaylistModal = ({ isVisible, playlists, onAddToPlaylist, onClose }) => {
    if (!isVisible) return null;

    return (
        <Modal animationType="fade" transparent visible={isVisible} onRequestClose={onClose}>
            <SafeAreaView style={styles.modalContainer}>
                {/* Allow closing by tapping outside */}
                <TouchableOpacity style={StyleSheet.absoluteFill} onPress={onClose} activeOpacity={1} />
                <View style={styles.modalContent}>
                    <View style={styles.modalHeader}>
                        <Text style={styles.modalTitle}>Add to Playlist</Text>
                        <TouchableOpacity onPress={onClose}><Ionicons name="close" size={28} color="#ccc" /></TouchableOpacity>
                    </View>
                    {playlists.length === 0 ? (
                        <Text style={styles.emptySubText}>No playlists created yet. Go to the Playlists tab to create one.</Text>
                    ) : (
                        <FlatList
                            data={playlists}
                            keyExtractor={(item) => item.id.toString()}
                            renderItem={({ item }) => (
                                <TouchableOpacity style={styles.playlistModalItem} onPress={() => onAddToPlaylist(item.id)}>
                                    <Ionicons name="musical-notes" size={20} color="#aaa" style={{ marginRight: 15 }} />
                                    <Text style={styles.playlistModalItemText}>{item.name}</Text>
                                </TouchableOpacity>
                            )}
                            ItemSeparatorComponent={() => <View style={styles.separator} />}
                        />
                    )}
                     <View style={styles.modalButtonContainer}>
                        <Button title="Close" onPress={onClose} color="#555" />
                     </View>
                </View>
            </SafeAreaView>
        </Modal>
    );
};

// --- CreatePlaylistModal ---
const CreatePlaylistModal = ({ isVisible, onCreate, onClose }) => {
    const [playlistName, setPlaylistName] = useState('');

    const handleCreate = () => {
        const trimmedName = playlistName.trim();
        if (trimmedName) {
            onCreate(trimmedName);
            setPlaylistName(''); // Reset for next time
            // onClose(); // Close modal after creation
        } else {
            Alert.alert("Invalid Name", "Please enter a name for the playlist.");
        }
    };

    // Reset name when modal becomes visible
    useEffect(() => {
        if (isVisible) {
            setPlaylistName('');
        }
    }, [isVisible]);

    return (
        <Modal animationType="slide" transparent visible={isVisible} onRequestClose={onClose}>
            <SafeAreaView style={styles.modalContainer}>
                 {/* Allow closing by tapping outside */}
                <TouchableOpacity style={StyleSheet.absoluteFill} onPress={onClose} activeOpacity={1} />
                <View style={styles.modalContent}>
                    <View style={styles.modalHeader}>
                        <Text style={styles.modalTitle}>Create New Playlist</Text>
                        <TouchableOpacity onPress={onClose}><Ionicons name="close" size={28} color="#ccc" /></TouchableOpacity>
                    </View>
                    <TextInput
                        style={styles.playlistInput}
                        placeholder="Playlist Name"
                        placeholderTextColor="#888"
                        value={playlistName}
                        onChangeText={setPlaylistName}
                        autoFocus
                        onSubmitEditing={handleCreate} // Allow creation on submit
                    />
                    <View style={styles.modalButtonContainer}>
                        <Button title="Create Playlist" onPress={handleCreate} color="#1DB954" />
                    </View>
                    <View style={styles.modalButtonContainer}>
                        <Button title="Cancel" onPress={onClose} color="#555" />
                    </View>
                </View>
            </SafeAreaView>
        </Modal>
    );
};


// --- LibraryScreen Component ---
function LibraryScreen({
    filterType = 'all', library, dbInitialized, isDbLoading, isRefreshing,
    fetchingMetadataIds, currentMedia, playbackStatus, playlists, // <-- Added playlists
    onLoadAndPlay, onRefreshData, onToggleFavorite, onDeleteMedia, onPickFiles,
    onRequestMetadataFetch, onDownloadMedia, isFocused, onViewParamsChange,
    onShowAddToPlaylist, // <-- Added prop to show playlist modal
}) {
    const [searchQuery, setSearchQuery] = useState('');
    const [isSearching, setIsSearching] = useState(false);
    // Default sort: Web = Newest Added, Native = Name A-Z
    const [currentSort, setCurrentSort] = useState(Platform.OS === 'web' ? 'addedDate DESC' : 'name ASC');

    // Update view params when focus/filters change
    useEffect(() => {
        if (isFocused && onViewParamsChange) {
            onViewParamsChange({ filterType, sort: currentSort, searchQuery: isSearching ? searchQuery : '' });
        }
    }, [isFocused, filterType, currentSort, searchQuery, isSearching, onViewParamsChange]);

    // Web-specific sorting function
    const sortWebData = useCallback((data, sortBy) => {
        if (Platform.OS !== 'web' || !data || data.length === 0) return data;

        const [sortField, sortDirection] = sortBy.split(' ');
        const directionMultiplier = sortDirection === 'DESC' ? -1 : 1;

        // Create a copy before sorting
        return [...data].sort((a, b) => {
            let valA = a[sortField];
            let valB = b[sortField];

            // Handle null/undefined values consistently (e.g., push them to the end)
            if (valA == null && valB == null) return 0;
            if (valA == null) return 1 * directionMultiplier; // Nulls last when ASC
            if (valB == null) return -1 * directionMultiplier; // Nulls last when ASC

            // Handle different types
            if (typeof valA === 'string' && typeof valB === 'string') {
                // Case-insensitive sorting
                return valA.localeCompare(valB, undefined, { sensitivity: 'base' }) * directionMultiplier;
            } else if (typeof valA === 'number' && typeof valB === 'number') {
                return (valA - valB) * directionMultiplier;
            } else {
                // Fallback to string comparison if types differ or are not string/number
                const strA = String(valA);
                const strB = String(valB);
                return strA.localeCompare(strB, undefined, { sensitivity: 'base' }) * directionMultiplier;
            }
        });
    }, []); // No dependencies needed for this pure function

    const handleSortChange = useCallback((newSort) => {
        if (newSort !== currentSort) {
            console.log("Setting sort to:", newSort);
            setCurrentSort(newSort);
        }
    }, [currentSort]); // Depends only on currentSort

    const showSortOptions = useCallback(() => {
        const webOptions = [
            { text: "Name (A-Z)", onPress: () => handleSortChange('name ASC') },
            { text: "Name (Z-A)", onPress: () => handleSortChange('name DESC') },
            { text: "Date Added (Newest)", onPress: () => handleSortChange('addedDate DESC') },
            { text: "Date Added (Oldest)", onPress: () => handleSortChange('addedDate ASC') },
            { text: "Artist (A-Z)", onPress: () => handleSortChange('artistName ASC') },
            { text: "Album (A-Z)", onPress: () => handleSortChange('albumName ASC') },
            { text: "Last Played (Newest)", onPress: () => handleSortChange('lastPlayed DESC') },
            { text: "Cancel", style: "cancel" },
        ];
        const nativeOptions = [
            { text: "Name (A-Z)", onPress: () => handleSortChange('name ASC') },
            // { text: "Name (Z-A)", onPress: () => handleSortChange('name DESC') }, // Can add if needed
            { text: "Date Added (Newest)", onPress: () => handleSortChange('addedDate DESC') },
            // { text: "Date Added (Oldest)", onPress: () => handleSortChange('addedDate ASC') }, // Can add if needed
            { text: "Cancel", style: "cancel" },
        ];
        const options = Platform.OS === 'web' ? webOptions : nativeOptions;
        // Display current sort selection
        const currentSortText = options.find(opt => opt.onPress?.toString().includes(currentSort))?.text || currentSort;
        Alert.alert("Sort By", `Current: ${currentSortText}`, options);
    }, [currentSort, handleSortChange]); // Depends on currentSort and the handler

    const handleSearch = (text) => {
        setSearchQuery(text);
    };

    const toggleSearch = () => {
        const nextIsSearching = !isSearching;
        setIsSearching(nextIsSearching);
        if (!nextIsSearching) {
            setSearchQuery(''); // Clear search query when closing search bar
        }
    };

    const clearSearch = () => {
        setSearchQuery('');
    };

    // Memoized filtered and sorted results
    const filteredAndSortedResults = useMemo(() => {
        let results = library;

        // 1. Filter by Tab Type
        if (filterType !== 'all') {
            if (filterType === 'favorites') {
                // Favorites now work on both platforms using the boolean flag
                results = results.filter(item => !!item.isFavorite); // Check truthiness
            } else {
                results = results.filter(item => item.type === filterType);
            }
        }

        // 2. Filter by Search Query (Case-insensitive)
        if (isSearching && searchQuery) {
            const queryLower = searchQuery.toLowerCase().trim();
            if (queryLower) {
                results = results.filter(item => {
                    const name = (item.name || '').toLowerCase();
                    const trackName = (item.trackName || '').toLowerCase();
                    const artistName = (item.artistName || '').toLowerCase();
                    const albumName = (item.albumName || '').toLowerCase();
                    // Check if any relevant field includes the query
                    return name.includes(queryLower) ||
                           trackName.includes(queryLower) ||
                           artistName.includes(queryLower) ||
                           albumName.includes(queryLower);
                });
            }
        }

        // 3. Sort Results
        if (Platform.OS === 'web') {
            results = sortWebData(results, currentSort);
        } else {
             // Native sorting (simpler for now)
             results = [...results]; // Create a copy before sorting
             if (currentSort.startsWith('addedDate')) {
                 // Sort by date descending (newest first)
                 results.sort((a, b) => (b.addedDate ?? 0) - (a.addedDate ?? 0));
             } else { // Default to name ascending
                 results.sort((a, b) => (a.name ?? '').localeCompare(b.name ?? '', undefined, { sensitivity: 'base' }));
             }
        }
        return results;
    }, [library, filterType, searchQuery, isSearching, currentSort, sortWebData]); // Dependencies

    // --- Long Press Menu ---
    const handleLongPress = useCallback((item) => {
        const options = [];
        let message = `Type: ${item.type || 'Unknown'}`;
        if (item.durationMillis != null && item.type !== 'image' && item.type !== 'lyrics') message += `\nDuration: ${formatTime(item.durationMillis)}`;
        if (item.addedDate) message += `\nAdded: ${new Date(item.addedDate * 1000).toLocaleDateString()}`;
        if (item.lastPlayed && Platform.OS === 'web') message += `\nPlayed: ${new Date(item.lastPlayed * 1000).toLocaleString()}`;

        // Favorite Option (Both Platforms)
        const isFav = !!item.isFavorite; // Check truthiness
        options.push({ text: isFav ? "Remove from Favorites" : "Add to Favorites", onPress: () => onToggleFavorite(item.id, !isFav) });

        // Add to Playlist Option (Audio/Video only)
        // Check if the handler exists before adding the option
        if ((item.type === 'audio' || item.type === 'video') && onShowAddToPlaylist) {
             if (playlists && playlists.length > 0) {
                 options.push({ text: "Add to Playlist...", onPress: () => onShowAddToPlaylist(item.id) });
             } else {
                 // Option to add, but inform user no playlists exist
                 options.push({ text: "Add to Playlist...", onPress: () => Alert.alert("No Playlists", "Create a playlist first in the Playlists tab.") });
             }
        }

        // Web-specific options
        if (Platform.OS === 'web') {
            // Option to fetch metadata if not checked (spotifyChecked === 0)
            if (item.type === 'audio' && item.spotifyChecked === 0 && onRequestMetadataFetch) {
                 options.push({ text: "Fetch Metadata (Spotify)", onPress: () => onRequestMetadataFetch(item) });
            }
            // Option to download if it's a blob URI
            if (item.uri && item.uri.startsWith('blob:') && onDownloadMedia) {
                options.push({ text: "Download File", onPress: () => onDownloadMedia(item.uri, item.name) });
            }
        }

        // Delete/Remove Option
        options.push({
            text: Platform.OS === 'web' ? "Delete from Library" : "Remove from List",
            style: "destructive",
            onPress: () => onDeleteMedia(item) // Call the passed delete handler
        });

        options.push({ text: "Cancel", style: "cancel" });

        Alert.alert(item.trackName || item.name || 'Media Item', message, options);
    }, [playlists, onToggleFavorite, onDeleteMedia, onRequestMetadataFetch, onDownloadMedia, onShowAddToPlaylist]); // Added dependencies

    const renderHeader = () => (
        <View style={styles.header}>
            {/* Show Sort button only when not searching */}
            {!isSearching && (
                <TouchableOpacity onPress={showSortOptions} style={styles.headerIcon}>
                    <Ionicons name="filter" size={24} color="white" />
                </TouchableOpacity>
            )}
            {/* Show Title only when not searching */}
            {!isSearching && (
                <Text style={styles.headerTitle} numberOfLines={1}>
                    {filterType === 'all' ? 'Library' :
                     filterType === 'favorites' ? 'Favorites' :
                     filterType === 'playlists' ? 'Playlists' : // Should not happen here, but for safety
                     filterType.charAt(0).toUpperCase() + filterType.slice(1)}
                </Text>
            )}
            {/* Show Search button only when not searching */}
            {!isSearching && (
                <TouchableOpacity onPress={toggleSearch} style={styles.headerIcon}>
                    <Ionicons name="search" size={24} color="white" />
                </TouchableOpacity>
            )}
            {/* Search Bar Component (conditionally rendered) */}
            <SearchBarComponent
                isSearching={isSearching}
                searchQuery={searchQuery}
                onToggleSearch={toggleSearch}
                onSearchChange={handleSearch}
                onClearSearch={clearSearch}
            />
        </View>
    );

    const renderEmptyListComponent = () => (
        <View style={styles.emptyContainer}>
            <Ionicons name="library-outline" size={60} color="#555" />
            <Text style={styles.emptyText}>
                {isSearching ? 'No results found' :
                 filterType === 'favorites' ? 'No favorites yet' :
                 `No ${filterType === 'all' ? 'media' : filterType} files`}
            </Text>
            <Text style={styles.emptySubText}>
                {isSearching ? 'Try adjusting your search query or filters.' :
                 filterType === 'favorites' ? 'Long-press an item to add it to favorites.' :
                 Platform.OS === 'web' ? 'Use the "+" button to add files from your computer.' :
                 'Use the "+" button in Settings to add files, or scan your device.'}
            </Text>
             {/* Add Refresh hint if list is empty but not searching */}
             {!isSearching && library.length === 0 && (
                 <TouchableOpacity onPress={() => onRefreshData(currentSort)} style={{ marginTop: 20 }}>
                     <Text style={{ color: '#1DB954', fontSize: 14 }}>Tap to Refresh</Text>
                 </TouchableOpacity>
             )}
        </View>
    );

    // Memoized renderItem callback for FlatList
    const renderItemCallback = useCallback(({ item }) => (
        <MediaListItem
            item={item}
            isCurrent={currentMedia?.id === item.id}
            // Check playbackStatus exists before accessing isPlaying
            isPlaying={!!playbackStatus?.isPlaying && currentMedia?.id === item.id}
            isLoadingMeta={fetchingMetadataIds.has(item.id)}
            onPress={onLoadAndPlay}
            onLongPress={handleLongPress}
            isFavorite={!!item.isFavorite} // Pass favorite status (boolean)
        />
    ), [currentMedia?.id, playbackStatus?.isPlaying, fetchingMetadataIds, onLoadAndPlay, handleLongPress]); // Dependencies

    // Calculate padding based on mini-player visibility
    const listPaddingBottom = (currentMedia && !['image', 'document', 'lyrics', 'unknown'].includes(currentMedia.type))
                              ? MINI_PLAYER_HEIGHT + 10 // Add space for mini player
                              : (Platform.OS === 'web' ? 20 : 10); // Default padding

    return (
        <View style={styles.libraryScreenContainer}>
            {renderHeader()}
            <View style={styles.container}>
                {/* FAB for adding files (Web, All Files Tab, Not Searching, DB Initialized) */}
                {Platform.OS === 'web' && dbInitialized && !isSearching && filterType === 'all' && onPickFiles && (
                     <TouchableOpacity style={styles.fab} onPress={onPickFiles} disabled={isDbLoading}>
                         <Ionicons name="add" size={30} color="white" />
                     </TouchableOpacity>
                )}

                <FlatList
                    data={filteredAndSortedResults}
                    keyExtractor={(item) => item.id.toString()} // Ensure ID is string
                    renderItem={renderItemCallback}
                    ListEmptyComponent={renderEmptyListComponent}
                    contentContainerStyle={[styles.listContentContainer, { paddingBottom: listPaddingBottom }]}
                    maxToRenderPerBatch={15} // Performance tuning
                    initialNumToRender={10} // Performance tuning
                    windowSize={21} // Performance tuning
                    removeClippedSubviews={Platform.OS !== 'web'} // Generally true for native
                    getItemLayout={(data, index) => (
                        // Provide item height for optimization
                        { length: 65, offset: 65 * index, index }
                    )}
                    refreshControl={
                        <RefreshControl
                            refreshing={isRefreshing}
                            onRefresh={() => onRefreshData(currentSort)} // Pass current sort on refresh
                            tintColor="#ccc" // iOS spinner color
                            colors={['#1DB954', '#ccc']} // Android spinner colors
                            progressBackgroundColor="#282828" // Android background
                        />
                    }
                    // Add separator for better visual distinction
                    ItemSeparatorComponent={() => <View style={styles.separator} />}
                />
            </View>
        </View>
    );
}

// --- SettingsScreen Component ---
function SettingsScreen({ onScanDeviceMedia, onClearWebDB, isScanningNative, onPickDocument }) { // Added onPickDocument
     return (
        <SafeAreaView style={styles.placeholderSafeArea}>
            {/* Standard Header */}
            <View style={styles.header}>
                 <View style={styles.headerIcon} /> {/* Placeholder for alignment */}
                 <Text style={styles.headerTitle}>Settings</Text>
                 <View style={styles.headerIcon} /> {/* Placeholder for alignment */}
            </View>
            <ScrollView contentContainerStyle={styles.settingsScrollContainer}>
                <View style={styles.settingsIconContainer}>
                    <Ionicons name="settings-outline" size={60} color="#555" />
                </View>

                {/* Scan Button for Native */}
                {Platform.OS !== 'web' && (
                    <View style={styles.settingItem}>
                        <Button
                            title={isScanningNative ? "Scanning..." : "Scan Device for Media"}
                            onPress={onScanDeviceMedia}
                            color="#1DB954"
                            disabled={isScanningNative}
                        />
                        <Text style={styles.settingDescription}>
                            Scans local storage for Audio, Video, and Image files found by the Media Library. This list is temporary for the current session unless items are added to playlists or favorites.
                        </Text>
                    </View>
                )}

                {/* Manual Add Button for Native */}
                {Platform.OS !== 'web' && (
                    <View style={styles.settingItem}>
                        <Button
                            title="Add Files Manually"
                            onPress={onPickDocument} // Use the passed function
                            color="#1DA1F2" // Different color
                        />
                        <Text style={styles.settingDescription}>
                            Select individual media files (Audio, Video, Image) using the document picker to add to the current session's library.
                        </Text>
                    </View>
                )}


                 {/* Clear DB Button for Web */}
                 {Platform.OS === 'web' && (
                    <View style={styles.settingItem}>
                        <Button
                            title="Clear Web Library (IndexedDB)"
                            onPress={onClearWebDB}
                            color="#c00" // Destructive action color
                        />
                         <Text style={styles.settingDescription}>
                            Deletes all media references and playlists stored in the browser's IndexedDB. Requires app reload. This action cannot be undone.
                        </Text>
                    </View>
                 )}

                 {/* API Key Info */}
                 <View style={styles.settingItem}>
                     <Text style={styles.settingTitle}>API Keys Status</Text>
                     <Text style={styles.settingDescription}>
                         {`Gemini Key: ${GEMINI_API_KEY && GEMINI_API_KEY !== "YOUR_API_KEY_HERE" && GEMINI_API_KEY !== "AIzaSyDtzOBprQ3AvPrtieLJJjVf69X_PkotWT4" ? 'Loaded' : 'Missing/Placeholder'}`}
                         {`\nSpotify ID: ${SPOTIFY_CLIENT_ID ? 'Loaded' : 'Missing'}`}
                         {`\nSpotify Secret: ${SPOTIFY_CLIENT_SECRET ? 'Loaded' : 'Missing'}`}
                         {(!GEMINI_API_KEY || GEMINI_API_KEY === "YOUR_API_KEY_HERE" || GEMINI_API_KEY === "AIzaSyDtzOBprQ3AvPrtieLJJjVf69X_PkotWT4" || !SPOTIFY_CLIENT_ID || !SPOTIFY_CLIENT_SECRET) && "\n(Some features like lyrics or metadata fetching might be disabled)"}
                     </Text>
                     <Text style={[styles.settingDescription, { color: '#ffcc00', marginTop: 5 }]}>
                         Warning: API keys are exposed in the code. Use a secure method in production.
                     </Text>
                 </View>

                 <View style={styles.settingItem}>
                     <Text style={styles.placeholderSubText}>More settings coming soon...</Text>
                 </View>
            </ScrollView>
        </SafeAreaView>
    );
}

// --- PlaylistsScreen Component ---
function PlaylistsScreen({ playlists, onCreatePlaylist, onNavigateToPlaylist, onDeletePlaylist, onRenamePlaylist }) {
    const [showCreateModal, setShowCreateModal] = useState(false);

    const handleLongPressPlaylist = (playlist) => {
        Alert.alert(
            playlist.name,
            `Tracks: ${playlist.trackIds?.length || 0}`,
            [
                { text: "Open", onPress: () => onNavigateToPlaylist(playlist.id) },
                { text: "Rename", onPress: () => {
                    Alert.prompt(
                        "Rename Playlist",
                        "Enter new name:",
                        [
                            { text: "Cancel", style: "cancel" },
                            { text: "Rename", onPress: (newName) => {
                                const trimmedName = newName?.trim();
                                if (trimmedName && trimmedName !== playlist.name) {
                                    // Pass ID and an object with the 'name' field to update
                                    onRenamePlaylist(playlist.id, { name: trimmedName });
                                } else if (!trimmedName) {
                                    Alert.alert("Invalid Name", "Playlist name cannot be empty.");
                                }
                            }}
                        ],
                        'plain-text',
                        playlist.name // Default value is the current name
                    );
                }},
                { text: "Delete", style: "destructive", onPress: () => {
                    Alert.alert(
                        "Delete Playlist",
                        `Are you sure you want to delete the playlist "${playlist.name}"? This cannot be undone.`,
                        [
                            { text: "Cancel", style: "cancel" },
                            { text: "Delete", style: "destructive", onPress: () => onDeletePlaylist(playlist.id) }
                        ]
                    );
                }},
                { text: "Cancel", style: "cancel" },
            ],
            { cancelable: true } // Allow dismissing by tapping outside on Android
        );
    };

    const renderPlaylistItem = ({ item }) => (
        <TouchableOpacity
            style={styles.itemContainer} // Reuse item container style
            onPress={() => onNavigateToPlaylist(item.id)}
            onLongPress={() => handleLongPressPlaylist(item)}
        >
            {/* Playlist Icon */}
            <Ionicons name="list" size={30} color="#1DB954" style={styles.playlistIcon} />
            <View style={styles.itemTextContainer}>
                <Text style={styles.itemTitle} numberOfLines={1}>{item.name}</Text>
                <Text style={styles.itemSubtitle} numberOfLines={1}>{`${item.trackIds?.length || 0} tracks`}</Text>
            </View>
            {/* Chevron to indicate navigation */}
            <Ionicons name="chevron-forward" size={20} color="#888" />
        </TouchableOpacity>
    );

    return (
        <SafeAreaView style={styles.libraryScreenContainer}>
            {/* Simple Header for Playlists */}
            <View style={styles.header}>
                 <View style={styles.headerIcon} /> {/* Placeholder for alignment */}
                 <Text style={styles.headerTitle}>Playlists</Text>
                 {/* Add Playlist Button */}
                 <TouchableOpacity onPress={() => setShowCreateModal(true)} style={styles.headerIcon}>
                    <Ionicons name="add" size={28} color="white" />
                 </TouchableOpacity>
            </View>
            <FlatList
                data={playlists}
                keyExtractor={(item) => item.id.toString()} // Ensure ID is string
                renderItem={renderPlaylistItem}
                ListEmptyComponent={() => (
                    <View style={styles.emptyContainer}>
                        <Ionicons name="list-outline" size={60} color="#555" />
                        <Text style={styles.emptyText}>No Playlists Yet</Text>
                        <Text style={styles.emptySubText}>Tap the "+" button above to create your first playlist.</Text>
                    </View>
                )}
                contentContainerStyle={styles.listContentContainer}
                // Add separator for better visual distinction
                ItemSeparatorComponent={() => <View style={styles.separator} />}
            />
            {/* Create Playlist Modal */}
            <CreatePlaylistModal
                isVisible={showCreateModal}
                onCreate={(name) => {
                    onCreatePlaylist(name);
                    setShowCreateModal(false); // Close modal after creation
                }}
                onClose={() => setShowCreateModal(false)}
            />
        </SafeAreaView>
    );
}

// --- PlaylistDetailScreen Component ---
function PlaylistDetailScreen({ route, library, currentMedia, playbackStatus, onLoadAndPlay, onRemoveFromPlaylist }) {
    const navigation = useNavigation();
    // Ensure route.params and playlist exist before accessing properties
    const playlist = route.params?.playlist;

    // Find the tracks from the main library based on IDs in the playlist
    const playlistTracks = useMemo(() => {
        if (!playlist || !playlist.trackIds || !library) return [];
        const trackIdSet = new Set(playlist.trackIds); // Use Set for efficient lookup if needed, though map is fine here
        // Maintain order from playlist.trackIds
        return playlist.trackIds
                 .map(id => library.find(track => track.id === id)) // Find track in main library
                 .filter(track => track != null); // Filter out tracks that might have been deleted from library
    }, [playlist, library]); // Dependencies: playlist object and main library

    // Set header title dynamically based on playlist name
    useEffect(() => {
        navigation.setOptions({ title: playlist?.name || 'Playlist' });
    }, [navigation, playlist?.name]); // Update when name changes

    // Long press action: Remove track from *this* playlist
    const handleLongPressTrack = (track) => {
         Alert.alert(
             track.trackName || track.name || 'Track',
             `Remove "${track.trackName || track.name}" from this playlist?`,
             [
                 { text: "Cancel", style: "cancel" },
                 {
                     text: "Remove",
                     style: "destructive",
                     // Ensure playlist ID is passed correctly
                     onPress: () => onRemoveFromPlaylist(track.id, playlist?.id)
                 }
             ],
             { cancelable: true }
         );
    };

    // When playing a track from this screen, ensure the queue is set to the playlist tracks
    const handlePlayTrackFromPlaylist = useCallback((track) => {
        // Pass the playlistTracks as the explicit queue to maintain context
        onLoadAndPlay(track, true, playlistTracks);
    }, [onLoadAndPlay, playlistTracks]); // Dependencies

    // Memoized renderItem callback
    const renderItemCallback = useCallback(({ item }) => (
        <MediaListItem
            item={item}
            isCurrent={currentMedia?.id === item.id}
            isPlaying={!!playbackStatus?.isPlaying && currentMedia?.id === item.id}
            // No metadata loading indicator needed here usually, as metadata is fetched elsewhere
            isLoadingMeta={false}
            onPress={handlePlayTrackFromPlaylist} // Use specific play handler for playlist context
            onLongPress={handleLongPressTrack} // Use specific long press handler for removal
            isFavorite={!!item.isFavorite} // Show favorite status
            showTypeIcon={false} // Optionally hide type icon in playlist view for cleaner look
        />
    ), [currentMedia?.id, playbackStatus?.isPlaying, handlePlayTrackFromPlaylist, handleLongPressTrack]); // Dependencies

    // Calculate padding based on mini-player visibility
    const listPaddingBottom = (currentMedia && !['image', 'document', 'lyrics', 'unknown'].includes(currentMedia.type))
                              ? MINI_PLAYER_HEIGHT + 10
                              : 10;

    return (
        <View style={styles.libraryScreenContainer}>
            {/* Header is set by navigation options */}
            <FlatList
                data={playlistTracks}
                keyExtractor={(item) => item.id.toString()} // Ensure ID is string
                renderItem={renderItemCallback}
                ListEmptyComponent={() => (
                    <View style={styles.emptyContainer}>
                        <Ionicons name="musical-notes-outline" size={60} color="#555" />
                        <Text style={styles.emptyText}>Playlist Empty</Text>
                        <Text style={styles.emptySubText}>Long-press tracks in your library to add them here.</Text>
                    </View>
                )}
                contentContainerStyle={[styles.listContentContainer, { paddingBottom: listPaddingBottom }]}
                 // Add item separator for clarity
                 ItemSeparatorComponent={() => <View style={styles.separator} />}
            />
        </View>
    );
}


// --- Main App Component ---
const Tab = createBottomTabNavigator();
const Stack = createNativeStackNavigator(); // Create Stack Navigator instance

// Playlist Stack Navigator
function PlaylistStackScreen({ library, currentMedia, playbackStatus, playlists, onLoadAndPlay, onRemoveFromPlaylist, onCreatePlaylist, onDeletePlaylist, onRenamePlaylist }) {
    const navigation = useNavigation(); // Hook to access navigation

    // Function to navigate to detail screen, finding the playlist object first
    const handleNavigateToPlaylist = useCallback((playlistId) => {
        const playlist = playlists.find(p => p.id === playlistId);
        if (playlist) {
            // Navigate to the 'PlaylistDetail' screen, passing the full playlist object
            navigation.navigate('PlaylistDetail', { playlist });
        } else {
            console.warn("Playlist not found for navigation:", playlistId);
            Alert.alert("Error", "Could not find the selected playlist.");
        }
    }, [navigation, playlists]); // Dependencies

    return (
        <Stack.Navigator
            screenOptions={{
                headerStyle: { backgroundColor: '#121212' },
                headerTintColor: 'white',
                headerTitleStyle: { fontWeight: 'bold' },
                headerBackTitleVisible: false, // Hide "Back" text on iOS
            }}
        >
            {/* Screen for the list of playlists */}
            <Stack.Screen name="PlaylistList" options={{ headerShown: false }}>
                 {/* Pass props down to PlaylistsScreen */}
                 {(props) => (
                    <PlaylistsScreen
                        {...props} // Pass navigation props
                        playlists={playlists}
                        onCreatePlaylist={onCreatePlaylist}
                        onDeletePlaylist={onDeletePlaylist}
                        onRenamePlaylist={onRenamePlaylist} // Pass rename handler
                        onNavigateToPlaylist={handleNavigateToPlaylist} // Use the navigation function
                    />
                 )}
            </Stack.Screen>
            {/* Screen for the details of a single playlist */}
            <Stack.Screen
                name="PlaylistDetail"
                // Set title dynamically based on route params
                options={({ route }) => ({ title: route.params?.playlist?.name || 'Playlist' })}
            >
                 {/* Pass props down to PlaylistDetailScreen */}
                 {(props) => (
                    <PlaylistDetailScreen
                        {...props} // Pass route and navigation props
                        library={library}
                        currentMedia={currentMedia}
                        playbackStatus={playbackStatus}
                        onLoadAndPlay={onLoadAndPlay}
                        onRemoveFromPlaylist={onRemoveFromPlaylist}
                    />
                 )}
            </Stack.Screen>
        </Stack.Navigator>
    );
}


export default function App() {
    // --- State ---
    const [library, setLibrary] = useState([]);
    const [playlists, setPlaylists] = useState([]); // <-- New state for playlists
    const [favoriteIds, setFavoriteIds] = useState(new Set()); // <-- New state for native favorite IDs
    const [currentMedia, setCurrentMedia] = useState(null);
    const [playbackInstance, setPlaybackInstance] = useState(null); // Native playback object
    const [playbackStatus, setPlaybackStatus] = useState(null); // Unified status object
    const [isLoading, setIsLoading] = useState(true); // General loading (initial load, media change)
    const [isDbLoading, setIsDbLoading] = useState(Platform.OS === 'web'); // Specific to DB operations (web)
    const [isFetchingMetadata, setIsFetchingMetadata] = useState(false); // Spotify background fetch
    const [fetchingMetadataIds, setFetchingMetadataIds] = useState(new Set()); // IDs being fetched
    const [isFetchingLyrics, setIsFetchingLyrics] = useState(false); // Gemini fetch
    const [showLyricsModal, setShowLyricsModal] = useState(false);
    const [currentLyricsChords, setCurrentLyricsChords] = useState('');
    const [spotifyToken, setSpotifyToken] = useState(null);
    const [spotifyTokenExpiry, setSpotifyTokenExpiry] = useState(0);
    const [dbInitialized, setDbInitialized] = useState(false); // Web DB ready?
    const [appState, setAppState] = useState(AppState.currentState);
    const [isPlayerFullScreen, setIsPlayerFullScreen] = useState(false);
    const [isRefreshing, setIsRefreshing] = useState(false); // Pull-to-refresh state
    const [showImageViewer, setShowImageViewer] = useState(false);
    const [imageViewerIndex, setImageViewerIndex] = useState(0);
    const [imageViewerList, setImageViewerList] = useState([]);
    const [volume, setVolume] = useState(1.0);
    const [rate, setRate] = useState(1.0);
    const [isLooping, setIsLooping] = useState(false);
    const [playbackQueue, setPlaybackQueue] = useState([]); // Current queue for playback
    const [currentQueueIndex, setCurrentQueueIndex] = useState(-1); // Index in playbackQueue
    const [currentViewParams, setCurrentViewParams] = useState({ filterType: 'all', sort: Platform.OS === 'web' ? 'addedDate DESC' : 'name ASC', searchQuery: '' }); // Params of the visible list
    const [eqGains, setEqGains] = useState(Array(EQ_BANDS.length).fill(0)); // EQ gains state
    const [isScanningNative, setIsScanningNative] = useState(false); // Native media scan state
    const [permissionsGranted, setPermissionsGranted] = useState(Platform.OS === 'web'); // Media Library permissions (default true for web)
    const [showAddToPlaylistModal, setShowAddToPlaylistModal] = useState(false); // <-- State for playlist modal
    const [trackIdToAddToPlaylist, setTrackIdToAddToPlaylist] = useState(null); // <-- Track ID for modal

    // --- Web Audio API Refs ---
    const audioContextRef = useRef(null); // Web Audio API Context
    const audioSourceNodeRef = useRef(null); // Source node connected to <audio> element
    const eqNodesRef = useRef([]); // Array of BiquadFilterNodes for EQ
    const gainNodeRef = useRef(null); // Master gain node
    const webAudioElementRef = useRef(null); // Ref to the hidden <audio> element

    // --- Database Operations (Web ONLY using idb) ---
    const initDB = useCallback(async () => {
        if (Platform.OS !== 'web') {
            setDbInitialized(false); // Ensure false on native
            setIsDbLoading(false);
            return;
        }
        if (dbInitialized) return; // Avoid re-initialization

        setIsDbLoading(true);
        console.log("Attempting to initialize DB...");
        try {
            const db = await dbInstancePromise; // Wait for the promise created earlier
            if (db) {
                setDbInitialized(true);
                console.log("DB Initialized successfully.");
            } else {
                throw new Error("DB instance promise resolved to null.");
            }
        } catch (error) {
            console.error("Failed to initialize DB:", error);
            setDbInitialized(false);
            Alert.alert("Database Error", `Failed to initialize database: ${error.message}`);
        } finally {
            setIsDbLoading(false);
        }
    }, [dbInitialized]); // Depend on dbInitialized

    // --- Media DB Operations ---
    const addMediaToDB = useCallback(async (item) => {
        if (Platform.OS !== 'web' || !dbInitialized) return null;
        try {
            const db = await dbInstancePromise;
            // Ensure all fields expected by the DB schema are present with defaults
            const itemToAdd = {
                uri: item.uri,
                name: item.name || 'Unknown',
                type: item.type || 'unknown',
                durationMillis: item.durationMillis ?? null,
                isFavorite: item.isFavorite ?? 0, // Web uses 0/1
                lastPlayed: item.lastPlayed ?? null,
                spotifyChecked: item.spotifyChecked ?? 0, // 0=not checked, 1=found, 2=not found
                spotifyId: item.spotifyId ?? null,
                artistName: item.artistName ?? null,
                albumName: item.albumName ?? null,
                trackName: item.trackName ?? null, // Often same as name initially
                coverArtUrl: item.coverArtUrl ?? null,
                lyricsChords: item.lyricsChords ?? null,
                addedDate: item.addedDate ?? Math.floor(Date.now() / 1000),
            };
            const id = await db.add(STORE_NAME, itemToAdd);
            console.log(`Added item with id ${id}:`, itemToAdd.name);
            // Return the full item including the generated ID
            return { ...itemToAdd, id };
        } catch (error) {
            console.error(`Failed to add item ${item.name} to DB:`, error);
            if (error.name === 'ConstraintError') {
                // Attempt to find the existing item by URI
                try {
                    const db = await dbInstancePromise;
                    const existing = await db.getFromIndex(STORE_NAME, 'uri_idx', item.uri);
                    if (existing) {
                        Alert.alert("Duplicate Item", `"${item.name}" already exists in the library (ID: ${existing.id}).`);
                        return { ...existing, isFavorite: !!existing.isFavorite }; // Return existing item
                    } else {
                         Alert.alert("Duplicate Item", `An item with the same URI already exists, but couldn't retrieve it.`);
                    }
                } catch (findError) {
                    Alert.alert("Duplicate Item", `An item with the same URI already exists.`);
                }
            } else {
                Alert.alert("Database Error", `Could not add item: ${error.message}`);
            }
            return null; // Indicate failure
        }
    }, [dbInitialized]); // Depend on dbInitialized

    const updateMediaInDB = useCallback(async (id, updates) => {
        if (Platform.OS !== 'web' || !dbInitialized) return false;
        if (id == null) {
            console.warn("updateMediaInDB called with null ID.");
            return false;
        }
        try {
            const db = await dbInstancePromise;
            const tx = db.transaction(STORE_NAME, 'readwrite');
            const store = tx.objectStore(STORE_NAME);
            const existingItem = await store.get(id);

            if (existingItem) {
                // Create the updated item object
                const updatedItem = { ...existingItem, ...updates };

                // Ensure isFavorite is stored as 0 or 1 in the DB
                if (updates.hasOwnProperty('isFavorite')) {
                    updatedItem.isFavorite = updates.isFavorite ? 1 : 0;
                }

                await store.put(updatedItem);
                await tx.done; // Wait for transaction completion
                console.log(`Updated item id ${id} with:`, updates);

                // Update state (ensure isFavorite is boolean in state)
                const stateUpdate = { ...updates, isFavorite: !!updates.isFavorite };
                setLibrary(prevLibrary => prevLibrary.map(item =>
                    item.id === id ? { ...item, ...stateUpdate } : item
                ));
                // Update currentMedia if it's the one being updated
                if (currentMedia?.id === id) {
                    setCurrentMedia(prev => prev ? { ...prev, ...stateUpdate } : null);
                }
                return true;
            } else {
                console.warn(`Item with id ${id} not found for update.`);
                return false; // Item not found
            }
        } catch (error) {
            console.error(`Failed to update item id ${id} in DB:`, error);
            Alert.alert("Database Error", `Could not update item: ${error.message}`);
            return false;
        }
    }, [dbInitialized, currentMedia?.id]); // Depend on dbInitialized and currentMedia ID

    const deleteMediaFromDB = useCallback(async (id) => {
        if (Platform.OS !== 'web' || !dbInitialized) return false;
        if (id == null) {
             console.warn("deleteMediaFromDB called with null ID.");
             return false;
        }
        try {
            const db = await dbInstancePromise;
            await db.delete(STORE_NAME, id);
            console.log(`Deleted item with id ${id} from DB.`);
            return true;
        } catch (error) {
            console.error(`Failed to delete item id ${id} from DB:`, error);
            Alert.alert("Database Error", `Could not delete item: ${error.message}`);
            return false;
        }
    }, [dbInitialized]); // Depend on dbInitialized

    // --- Playlist DB/Storage Operations ---
    const loadPlaylists = useCallback(async () => {
        if (Platform.OS === 'web') {
            if (!dbInitialized) {
                console.warn("loadPlaylists (Web) called before DB initialized.");
                return; // Don't try to load if DB isn't ready
            }
            try {
                const db = await dbInstancePromise;
                const loadedPlaylists = await db.getAll(PLAYLIST_STORE_NAME);
                // Ensure trackIds is always an array
                const sanitizedPlaylists = loadedPlaylists.map(p => ({ ...p, trackIds: Array.isArray(p.trackIds) ? p.trackIds : [] }));
                console.log(`Loaded ${sanitizedPlaylists.length} playlists from IndexedDB.`);
                setPlaylists(sanitizedPlaylists || []);
            } catch (error) {
                console.error("Error loading playlists from IndexedDB:", error);
                setPlaylists([]); // Reset on error
            }
        } else {
            // Native: Load from AsyncStorage
            try {
                const jsonValue = await AsyncStorage.getItem(ASYNC_STORAGE_PLAYLISTS_KEY);
                const loadedPlaylists = jsonValue != null ? JSON.parse(jsonValue) : [];
                 // Ensure trackIds is always an array
                const sanitizedPlaylists = loadedPlaylists.map(p => ({ ...p, trackIds: Array.isArray(p.trackIds) ? p.trackIds : [] }));
                console.log(`Loaded ${sanitizedPlaylists.length} playlists from AsyncStorage.`);
                setPlaylists(sanitizedPlaylists);
            } catch (e) {
                console.error('Failed to load playlists from AsyncStorage.', e);
                setPlaylists([]); // Reset on error
            }
        }
    }, [dbInitialized]); // Depend on dbInitialized for web

    // Saves the entire playlist array (primarily for Native AsyncStorage)
    const savePlaylists = useCallback(async (updatedPlaylists) => {
        // Ensure trackIds are arrays before saving
        const sanitizedPlaylists = updatedPlaylists.map(p => ({ ...p, trackIds: Array.isArray(p.trackIds) ? p.trackIds : [] }));
        setPlaylists(sanitizedPlaylists); // Update state first

        if (Platform.OS === 'web') {
            // Web uses individual DB operations (add/update/deletePlaylist)
            // This function is mainly a state setter for web
            // console.warn("savePlaylists called on web - state updated, but use individual DB ops for persistence.");
        } else {
            // Native: Save the entire array to AsyncStorage
            try {
                const jsonValue = JSON.stringify(sanitizedPlaylists);
                await AsyncStorage.setItem(ASYNC_STORAGE_PLAYLISTS_KEY, jsonValue);
                console.log("Saved playlists to AsyncStorage.");
            } catch (e) {
                console.error('Failed to save playlists to AsyncStorage.', e);
            }
        }
    }, []); // No dependencies needed for this specific function structure

    const addPlaylist = useCallback(async (name) => {
        const newPlaylist = {
            // ID generated by DB on web, manually on native
            id: Platform.OS === 'web' ? null : generateUniqueId(),
            name: name,
            trackIds: [], // Initialize with empty array
            // createdDate: Math.floor(Date.now() / 1000), // Optional: Add creation timestamp
        };

        if (Platform.OS === 'web') {
            if (!dbInitialized) {
                Alert.alert("Error", "Database not initialized. Cannot create playlist.");
                return;
            }
            try {
                const db = await dbInstancePromise;
                // Add to DB, which returns the auto-generated ID
                const id = await db.add(PLAYLIST_STORE_NAME, newPlaylist);
                newPlaylist.id = id; // Assign the generated ID
                // Update state by adding the new playlist
                setPlaylists(prev => [...prev, newPlaylist]);
                console.log(`Added playlist "${name}" with ID ${id} to DB.`);
            } catch (error) {
                console.error(`Failed to add playlist ${name} to DB:`, error);
                Alert.alert("Database Error", `Could not add playlist: ${error.message}`);
            }
        } else {
            // Native: Add to state array and save all to AsyncStorage
            const updatedPlaylists = [...playlists, newPlaylist];
            await savePlaylists(updatedPlaylists); // savePlaylists updates state and saves
            console.log(`Added playlist "${name}" with ID ${newPlaylist.id} (Native).`);
        }
    }, [dbInitialized, playlists, savePlaylists]); // Dependencies

    // Updates specific fields of a playlist (e.g., name, trackIds)
    const updatePlaylist = useCallback(async (playlistId, updates) => {
        if (playlistId == null) {
            console.warn("updatePlaylist called with null ID.");
            return false;
        }
        // Ensure trackIds in updates is an array if present
        if (updates.trackIds && !Array.isArray(updates.trackIds)) {
            console.warn("updatePlaylist called with non-array trackIds, converting.");
            updates.trackIds = [];
        }

        if (Platform.OS === 'web') {
            if (!dbInitialized) return false;
            try {
                const db = await dbInstancePromise;
                const tx = db.transaction(PLAYLIST_STORE_NAME, 'readwrite');
                const store = tx.objectStore(PLAYLIST_STORE_NAME);
                const existing = await store.get(playlistId);
                if (existing) {
                    // Merge updates with existing playlist data
                    const updated = { ...existing, ...updates };
                    await store.put(updated);
                    await tx.done; // Wait for transaction
                    // Update state
                    setPlaylists(prev => prev.map(p => p.id === playlistId ? updated : p));
                    console.log(`Updated playlist ID ${playlistId} in DB with:`, updates);
                    return true;
                } else {
                    console.warn(`Playlist ID ${playlistId} not found for update in DB.`);
                    return false; // Playlist not found
                }
            } catch (error) {
                console.error(`Failed to update playlist ID ${playlistId} in DB:`, error);
                Alert.alert("Database Error", `Could not update playlist: ${error.message}`);
                return false;
            }
        } else {
            // Native: Find the playlist, update it, and save the entire array
            let playlistFound = false;
            const updatedPlaylists = playlists.map(p => {
                if (p.id === playlistId) {
                    playlistFound = true;
                    // Merge updates with existing playlist data
                    return { ...p, ...updates };
                }
                return p;
            });

            if (playlistFound) {
                 // Save the modified array (savePlaylists also updates state)
                 await savePlaylists(updatedPlaylists);
                 console.log(`Updated playlist ID ${playlistId} (Native) with:`, updates);
                 return true;
            } else {
                 console.warn(`Playlist ID ${playlistId} not found for update (Native).`);
                 return false; // Playlist not found
            }
        }
    }, [dbInitialized, playlists, savePlaylists]); // Dependencies

    const deletePlaylist = useCallback(async (playlistId) => {
         if (playlistId == null) {
            console.warn("deletePlaylist called with null ID.");
            return;
        }
        if (Platform.OS === 'web') {
            if (!dbInitialized) return;
            try {
                const db = await dbInstancePromise;
                await db.delete(PLAYLIST_STORE_NAME, playlistId);
                // Update state by filtering out the deleted playlist
                setPlaylists(prev => prev.filter(p => p.id !== playlistId));
                console.log(`Deleted playlist ID ${playlistId} from DB.`);
            } catch (error) {
                console.error(`Failed to delete playlist ID ${playlistId} from DB:`, error);
                Alert.alert("Database Error", `Could not delete playlist: ${error.message}`);
            }
        } else {
            // Native: Filter out the playlist and save the updated array
            const updatedPlaylists = playlists.filter(p => p.id !== playlistId);
            // Save the filtered array (savePlaylists also updates state)
            await savePlaylists(updatedPlaylists);
            console.log(`Deleted playlist ID ${playlistId} (Native).`);
        }
    }, [dbInitialized, playlists, savePlaylists]); // Dependencies

    // --- Playlist Track Management ---
    const handleAddToPlaylist = useCallback(async (trackId, playlistId) => {
        if (trackId == null || playlistId == null) return;

        const playlist = playlists.find(p => p.id === playlistId);
        if (!playlist) {
            console.warn(`Playlist ID ${playlistId} not found for adding track.`);
            Alert.alert("Error", "Playlist not found.");
            return;
        }

        // Ensure trackIds is an array
        const currentTrackIds = Array.isArray(playlist.trackIds) ? playlist.trackIds : [];

        // Avoid adding duplicates
        if (currentTrackIds.includes(trackId)) {
            // Alert.alert("Already Added", "This track is already in the playlist.");
            console.log(`Track ${trackId} already in playlist ${playlistId}.`);
            return; // Silently ignore or show subtle feedback
        }

        // Add track ID and update the playlist
        const updatedTrackIds = [...currentTrackIds, trackId];
        const success = await updatePlaylist(playlistId, { trackIds: updatedTrackIds });

        if (success) {
            // Optionally show confirmation
            // Alert.alert("Success", `Added track to "${playlist.name}"`);
            console.log(`Added track ${trackId} to playlist ${playlistId} ("${playlist.name}")`);
        } else {
             Alert.alert("Error", `Failed to add track to playlist "${playlist.name}".`);
        }
    }, [playlists, updatePlaylist]); // Dependencies

    const handleRemoveFromPlaylist = useCallback(async (trackId, playlistId) => {
        if (trackId == null || playlistId == null) return;

        const playlist = playlists.find(p => p.id === playlistId);
        if (!playlist) {
            console.warn(`Playlist ID ${playlistId} not found for removing track.`);
            // No alert needed usually, as this is called from the playlist detail screen
            return;
        }

        // Ensure trackIds is an array
        const currentTrackIds = Array.isArray(playlist.trackIds) ? playlist.trackIds : [];

        // Filter out the track ID
        const updatedTrackIds = currentTrackIds.filter(id => id !== trackId);

        // Update only if the array actually changed
        if (updatedTrackIds.length !== currentTrackIds.length) {
            const success = await updatePlaylist(playlistId, { trackIds: updatedTrackIds });
            if (success) {
                console.log(`Removed track ${trackId} from playlist ${playlistId} ("${playlist.name}")`);
            } else {
                 Alert.alert("Error", `Failed to remove track from playlist "${playlist.name}".`);
            }
        } else {
            console.log(`Track ${trackId} was not found in playlist ${playlistId} for removal.`);
        }
    }, [playlists, updatePlaylist]); // Dependencies

    // --- Native Favorites (AsyncStorage) ---
    const loadFavoritesFromStorage = useCallback(async () => {
        if (Platform.OS === 'web') return; // Only for native
        try {
            const jsonValue = await AsyncStorage.getItem(ASYNC_STORAGE_FAVORITES_KEY);
            const ids = jsonValue != null ? JSON.parse(jsonValue) : [];
            // Ensure it's stored as a Set
            setFavoriteIds(new Set(Array.isArray(ids) ? ids : []));
            console.log(`Loaded ${ids.length} favorite IDs from AsyncStorage.`);
        } catch (e) {
            console.error('Failed to load favorites from AsyncStorage.', e);
            setFavoriteIds(new Set()); // Reset on error
        }
    }, []); // No dependencies

    const saveFavoritesToStorage = useCallback(async (idsSet) => {
        if (Platform.OS === 'web') return;
        try {
            // Convert Set to Array for JSON serialization
            const jsonValue = JSON.stringify(Array.from(idsSet));
            await AsyncStorage.setItem(ASYNC_STORAGE_FAVORITES_KEY, jsonValue);
            console.log("Saved favorites to AsyncStorage.");
        } catch (e) {
            console.error('Failed to save favorites to AsyncStorage.', e);
        }
    }, []); // No dependencies

    // --- Permissions ---
    const checkAndRequestPermissions = useCallback(async () => {
        if (Platform.OS === 'web') {
            setPermissionsGranted(true); // No explicit permissions needed for web file picker
            return true;
        }
        try {
            console.log("Checking media library permissions...");
            // Request read and write permissions if needed later for saving/modifying
            let currentStatus = await MediaLibrary.getPermissionsAsync(true);
            console.log("Current permission status:", currentStatus.status);

            if (currentStatus.status !== 'granted') {
                if (currentStatus.canAskAgain) {
                    console.log("Requesting media library permissions...");
                    // Request read and write permissions
                    const { status } = await MediaLibrary.requestPermissionsAsync(true);
                    console.log("Requested permission status:", status);
                    if (status === 'granted') {
                        setPermissionsGranted(true);
                        return true;
                    } else {
                        Alert.alert('Permission Required', 'Media Library access is needed to scan or manage media.');
                        setPermissionsGranted(false);
                        return false;
                    }
                } else {
                    // Cannot ask again (denied permanently or restricted)
                    Alert.alert('Permission Required', 'Media Library access was denied. Please enable it in your device settings to allow scanning or managing media.');
                    setPermissionsGranted(false);
                    return false;
                }
            } else {
                setPermissionsGranted(true); // Already granted
                return true;
            }
        } catch (error) {
            console.error("Error checking/requesting permissions:", error);
            Alert.alert("Permission Error", "Could not verify media library permissions.");
            setPermissionsGranted(false);
            return false;
        }
    }, []); // No dependencies


    // --- Native Media Scanning ---
    const scanNativeMedia = useCallback(async () => {
        if (Platform.OS === 'web' || isScanningNative) return library; // Prevent concurrent scans

        // Check permissions first
        const hasPermission = await checkAndRequestPermissions();
        if (!hasPermission) {
            console.log("Scan aborted: Permissions not granted.");
            return []; // Return empty array or current library? Empty seems better.
        }

        console.log("Starting native media scan...");
        setIsScanningNative(true);
        setIsLoading(true); // Use general loading indicator during scan

        let scannedItems = [];
        try {
            console.log("Querying assets with pagination...");
            let allAssets = [];
            let hasNextPage = true;
            let after = undefined;
            const BATCH_SIZE = 100; // Fetch in batches
            let page = 1;
            let totalFetched = 0;

            while (hasNextPage) {
                console.log(`Fetching page ${page} (after: ${after})...`);
                const assetsResult = await MediaLibrary.getAssetsAsync({
                    mediaType: [MediaLibrary.MediaType.audio, MediaLibrary.MediaType.video, MediaLibrary.MediaType.photo],
                    first: BATCH_SIZE,
                    after: after,
                    // Sort by creation time might be more useful than default
                    sortBy: [MediaLibrary.SortBy.creationTime],
                });

                if (assetsResult.assets && assetsResult.assets.length > 0) {
                    allAssets = allAssets.concat(assetsResult.assets);
                    totalFetched += assetsResult.assets.length;
                    after = assetsResult.endCursor;
                    hasNextPage = assetsResult.hasNextPage;
                    console.log(`Fetched ${assetsResult.assets.length} assets (Total: ${totalFetched}), More: ${hasNextPage}`);
                    page++;
                    // Optional small delay between pages if hitting performance issues
                    // await new Promise(resolve => setTimeout(resolve, 50));
                } else {
                    hasNextPage = false;
                    console.log("No more assets found in this page.");
                }
            }
            console.log(`Scan complete. Found ${totalFetched} media assets.`);

            // Map assets to app's format, check against loaded favorite IDs
            scannedItems = allAssets.map((asset) => ({
                // Use a prefix to avoid potential ID collisions if ever mixing sources
                id: `native_${asset.id}`,
                name: asset.filename || `Unnamed ${asset.mediaType}`,
                uri: asset.uri, // This is the crucial URI for playback/display
                type: mapAssetType(asset.mediaType),
                durationMillis: asset.duration ? asset.duration * 1000 : null, // Convert seconds to ms
                // Use creationTime if available, fallback to modificationTime or now
                addedDate: asset.creationTime ? Math.floor(asset.creationTime / 1000) : (asset.modificationTime ? Math.floor(asset.modificationTime / 1000) : Math.floor(Date.now() / 1000)),
                // Check if the generated ID is in the favorites set loaded from AsyncStorage
                isFavorite: favoriteIds.has(`native_${asset.id}`),
                // Default other fields expected by the app structure
                spotifyChecked: 0, lastPlayed: null, lyricsChords: null, spotifyId: null,
                artistName: null, albumName: null, trackName: null, coverArtUrl: null,
            })).filter(item => item.type !== 'unknown'); // Filter out types we don't handle

            console.log(`Mapped ${scannedItems.length} valid media items.`);
            setLibrary(scannedItems); // Update the main library state

        } catch (error) {
            console.error("Native Media Scan Error:", error);
            Alert.alert("Scan Error", `Could not scan device for media: ${error.message}`);
            // Optionally set library to empty or keep previous state? Keep previous might be safer.
            // setLibrary([]);
        } finally {
            setIsScanningNative(false);
            setIsLoading(false); // Turn off general loading indicator
        }
        return scannedItems; // Return the items found in this scan
    }, [isScanningNative, checkAndRequestPermissions, favoriteIds]); // Added dependencies

    // --- Load Library (Handles Both Platforms) ---
    const loadLibraryFromDB = useCallback(async (sortBy = 'addedDate DESC') => {
        setIsLoading(true);
        let items = [];
        if (Platform.OS === 'web') {
            // Ensure DB is initialized before loading
            if (!dbInitialized) {
                console.warn("loadLibraryFromDB (Web) called before DB initialized. Attempting init...");
                await initDB(); // Wait for initialization attempt
                // Check again after attempt
                if (!dbInitialized) {
                     console.error("DB initialization failed, cannot load library.");
                     setIsLoading(false);
                     setLibrary([]); // Set empty library if DB fails
                     return [];
                }
            }
            console.log(`Loading library (Web) sorted by: ${sortBy}`); // Sorting applied later by component
            try {
                const db = await dbInstancePromise;
                const allItems = await db.getAll(STORE_NAME);
                // Map items, ensuring all fields exist and correct types (e.g., boolean for isFavorite)
                items = allItems.map(item => ({
                    id: item.id,
                    uri: item.uri,
                    name: item.name || 'Unknown',
                    type: item.type || getFileType(item.name || item.uri),
                    durationMillis: item.durationMillis ?? null,
                    addedDate: item.addedDate ?? Math.floor(Date.now() / 1000),
                    isFavorite: !!item.isFavorite, // Ensure boolean for state
                    lastPlayed: item.lastPlayed ?? null,
                    spotifyChecked: item.spotifyChecked ?? 0,
                    spotifyId: item.spotifyId ?? null,
                    artistName: item.artistName ?? null,
                    albumName: item.albumName ?? null,
                    trackName: item.trackName ?? null,
                    coverArtUrl: item.coverArtUrl ?? null,
                    lyricsChords: item.lyricsChords ?? null,
                }));
                console.log(`Loaded ${items.length} items from IndexedDB.`);
                setLibrary(items); // Update state
            } catch (error) {
                console.error("Error loading library from IndexedDB:", error);
                Alert.alert("Load Error", `Could not load library: ${error.message}`);
                setLibrary([]); // Reset on error
            }
        } else {
            // Native: Load favorites first, then scan (scan applies favorite status)
            await loadFavoritesFromStorage(); // Ensure favorites are loaded before scan
            items = await scanNativeMedia(); // Scan updates the library state directly
            console.log("LoadLibrary (Native): Loaded favorites and scanned media.");
        }
        setIsLoading(false);
        return items; // Return the loaded items
    }, [dbInitialized, initDB, scanNativeMedia, loadFavoritesFromStorage]); // Dependencies


    // --- Initialization & App State ---
    useEffect(() => {
        const initializeApp = async () => {
            console.log("Starting App Initialization...");
            setIsLoading(true);
            try {
                // Configure audio settings for background playback etc.
                await Audio.setAudioModeAsync({
                    allowsRecordingIOS: false,
                    interruptionModeIOS: InterruptionModeIOS.DoNotMix, // Don't mix with other audio
                    playsInSilentModeIOS: true, // Play even if silent switch is on
                    staysActiveInBackground: true, // Crucial for background playback
                    interruptionModeAndroid: InterruptionModeAndroid.DoNotMix, // Don't mix
                    shouldDuckAndroid: false, // Don't lower volume, just pause/stop
                    playThroughEarpieceAndroid: false, // Use speaker
                });
                console.log("Audio mode set.");

                if (Platform.OS === 'web') {
                    await initDB(); // Initialize IndexedDB
                    // Only load library/playlists if DB init was successful
                    if (dbInitialized) {
                        await loadLibraryFromDB(currentViewParams.sort); // Load media library
                        await loadPlaylists(); // Load playlists from DB
                        await fetchSpotifyToken(); // Get initial Spotify token
                    } else {
                         console.warn("DB not initialized after init attempt, skipping initial load.");
                         // Keep loading indicator on, or show an error state?
                         // Maybe set loading false here but library remains empty.
                         setIsLoading(false);
                    }
                } else {
                    // Native: Check permissions, load persistent data (favs/playlists)
                    await checkAndRequestPermissions(); // Check/request permissions early
                    await loadFavoritesFromStorage(); // Load favorite IDs
                    await loadPlaylists(); // Load playlists from AsyncStorage
                    // Library is loaded on demand via scan or manual add on Native
                    // Set initial library state to empty, scanning happens in Settings or on refresh
                    setLibrary([]);
                    setDbInitialized(false); // Not applicable
                    setIsDbLoading(false); // Not applicable
                    console.log("Native platform: Checked permissions, loaded favorites/playlists. Library empty initially.");
                    setIsLoading(false); // Initial setup done for native
                }
                console.log("App Initialization sequence potentially complete.");
            } catch (error) {
                 console.error("App Initialization failed:", error);
                 Alert.alert("Initialization Error", `Failed to initialize the app: ${error.message}`);
                 setIsLoading(false); // Ensure loading is turned off on error
            } finally {
                 // Ensure loading is off if not already turned off by platform-specific logic
                 // This might be redundant but safe.
                 // setIsLoading(false);
            }
        };
        initializeApp();

        // App State Listener (Foreground/Background changes)
        const handleAppStateChange = (nextAppState) => {
            console.log("AppState changed from", appState, "to:", nextAppState);
            if (appState.match(/inactive|background/) && nextAppState === 'active') {
                console.log('App has come to the foreground!');
                // Refresh Spotify token if needed on web
                if (Platform.OS === 'web') {
                    fetchSpotifyToken(); // Check and refresh if necessary
                }
                // Optionally re-check permissions on native when coming to foreground
                if (Platform.OS !== 'web') {
                    checkAndRequestPermissions();
                }
                // Potentially trigger a data refresh?
                // handleRefreshData(); // Decide if this is desired behavior
            } else if (nextAppState.match(/inactive|background/)) {
                 console.log('App has gone to the background.');
                 // Potential background tasks or state saving could happen here
            }
            setAppState(nextAppState); // Update state
        };
        const subscription = AppState.addEventListener('change', handleAppStateChange);

        // Cleanup function on component unmount
        return () => {
            console.log("Cleaning up App component...");
            subscription.remove(); // Remove AppState listener

            // Unload native playback instance
            if (Platform.OS !== 'web' && playbackInstance) {
                console.log("Unloading native playback instance.");
                playbackInstance.unloadAsync().catch(e => console.error("Error unloading native instance:", e));
            }

             // Web cleanup: Revoke Object URLs, close Audio Context
             if (Platform.OS === 'web') {
                 console.log("Revoking Object URLs and closing Audio Context...");
                 // Revoke URLs stored in the library state
                 library.forEach(item => {
                     if (item.uri?.startsWith('blob:')) {
                         try { URL.revokeObjectURL(item.uri); } catch (e) { console.warn("Error revoking URL:", item.uri, e); }
                     }
                 });
                 // Close Web Audio API context
                 if (audioContextRef.current) {
                     audioContextRef.current.close().then(() => console.log("Audio Context closed.")).catch(e => console.error("Error closing Audio Context:", e));
                     audioContextRef.current = null;
                 }
                 // Disconnect source node if it exists
                 if (audioSourceNodeRef.current) {
                    try { audioSourceNodeRef.current.disconnect(); } catch(e) { /* Ignore */ }
                    audioSourceNodeRef.current = null;
                 }
                 // Stop and clear the web audio element
                 if (webAudioElementRef.current) {
                     webAudioElementRef.current.pause();
                     webAudioElementRef.current.removeAttribute('src');
                     webAudioElementRef.current.load();
                 }
             }
        };
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, []); // Run only once on mount

    // --- Spotify API ---
    const fetchSpotifyToken = useCallback(async () => {
        // Return current token if valid and not expiring soon (e.g., within 5 mins)
        if (spotifyToken && spotifyTokenExpiry > Date.now() + 5 * 60 * 1000) {
            // console.log("Using existing Spotify token.");
            return spotifyToken;
        }

        console.log("Fetching new Spotify token...");
        // Check if credentials are provided
        if (!SPOTIFY_CLIENT_ID || !SPOTIFY_CLIENT_SECRET) {
            console.warn("Spotify client ID or secret missing. Cannot fetch token.");
            return null;
        }

        try {
            // Encode credentials for Basic Auth header
            const credentials = btoa(SPOTIFY_CLIENT_ID + ':' + SPOTIFY_CLIENT_SECRET);
            const response = await fetch(SPOTIFY_TOKEN_URL, {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/x-www-form-urlencoded',
                    'Authorization': `Basic ${credentials}`
                },
                body: 'grant_type=client_credentials' // Request client credentials grant
            });

            if (!response.ok) {
                throw new Error(`Spotify token request failed: ${response.status} ${response.statusText}`);
            }

            const data = await response.json();
            const newToken = data.access_token;
            // Calculate expiry time in milliseconds
            const expiryTime = Date.now() + (data.expires_in * 1000);

            setSpotifyToken(newToken);
            setSpotifyTokenExpiry(expiryTime);
            console.log("Successfully fetched new Spotify token.");
            return newToken;
        } catch (error) {
            console.error("Error fetching Spotify token:", error);
            setSpotifyToken(null); // Reset token state on error
            setSpotifyTokenExpiry(0);
            // Optionally alert the user or handle specific errors (e.g., invalid credentials)
            // Alert.alert("Spotify Error", "Could not authenticate with Spotify.");
            return null;
        }
    }, [spotifyToken, spotifyTokenExpiry]); // Dependencies: current token and expiry

    const searchSpotifyAndFetchMetadata = useCallback(async (item) => {
        // Guard clauses: Web only, DB initialized, valid item, audio type, not already fetching this ID
        if (Platform.OS !== 'web' || !dbInitialized || !item || item.type !== 'audio') return;
        if (fetchingMetadataIds.has(item.id)) {
            // console.log(`Already fetching metadata for: ${item.name}`);
            return;
        }

        console.log(`Requesting metadata fetch for: ${item.name} (ID: ${item.id})`);
        // Add ID to the set of items currently being fetched
        setFetchingMetadataIds(prev => new Set(prev).add(item.id));

        let success = false;
        try {
            let currentToken = await fetchSpotifyToken(); // Ensure token is fresh
            if (!currentToken) {
                throw new Error("Invalid or missing Spotify token.");
            }

            // Clean the filename to create a search term
            const searchTerm = cleanFilenameForSearch(item.name);
            if (!searchTerm) {
                console.warn(`Could not generate search term for ${item.name}. Marking as checked (not found).`);
                await updateMediaInDB(item.id, { spotifyChecked: 2 }); // Mark as checked (not found)
                success = true; // Operation completed (marked as checked)
                return; // Exit early
            }

            console.log(`Searching Spotify for: "${searchTerm}"`);
            const searchUrl = `${SPOTIFY_SEARCH_URL}?q=${encodeURIComponent(searchTerm)}&type=track&limit=5`; // Limit results

            const response = await fetch(searchUrl, { headers: { 'Authorization': `Bearer ${currentToken}` } });

            if (!response.ok) {
                 // Handle expired token specifically
                 if (response.status === 401) {
                     console.warn("Spotify token expired during search. Refetching and retrying...");
                     setSpotifyToken(null); setSpotifyTokenExpiry(0); // Force refetch on next call
                     currentToken = await fetchSpotifyToken(); // Get a new token immediately
                     if (!currentToken) throw new Error("Failed to refresh Spotify token.");
                     // Retry the search with the new token
                     const retryResponse = await fetch(searchUrl, { headers: { 'Authorization': `Bearer ${currentToken}` } });
                     if (!retryResponse.ok) throw new Error(`Spotify search failed after retry: ${retryResponse.status}`);
                     const data = await retryResponse.json();
                     // Continue processing with 'data' below
                 } else {
                     // Other HTTP errors
                     throw new Error(`Spotify search failed: ${response.status}`);
                 }
            }
            // Process successful response (or retry response)
            const data = await response.json();
            const tracks = data.tracks?.items;

            if (tracks && tracks.length > 0) {
                // Basic matching: Assume the first result is the best match
                // More sophisticated matching could compare duration, artist if available, etc.
                const bestMatch = tracks[0];
                const metadata = {
                    trackName: bestMatch.name,
                    artistName: bestMatch.artists?.map(a => a.name).join(', ') || null,
                    albumName: bestMatch.album?.name || null,
                    coverArtUrl: bestMatch.album?.images?.[0]?.url || null, // Use largest image if available? Index 0 is usually largest.
                    spotifyId: bestMatch.id,
                    spotifyChecked: 1, // Mark as found
                    // Use Spotify duration if available and seems valid, otherwise keep original
                    durationMillis: bestMatch.duration_ms || item.durationMillis
                };
                console.log(`Found Spotify match for ${item.name}: ${metadata.trackName} by ${metadata.artistName}`);
                await updateMediaInDB(item.id, metadata); // Update the item in the DB
                success = true;
            } else {
                console.log(`No Spotify match found for ${item.name}`);
                await updateMediaInDB(item.id, { spotifyChecked: 2 }); // Mark as checked (not found)
                success = true;
            }
        } catch (error) {
            console.error(`Error searching Spotify for ${item.name} (ID: ${item.id}):`, error);
            // Optionally reset spotifyChecked to 0 to allow retrying later? Or leave as is?
            // await updateMediaInDB(item.id, { spotifyChecked: 0 });
        } finally {
            // Remove ID from the fetching set regardless of success/failure
            setFetchingMetadataIds(prev => {
                const next = new Set(prev);
                next.delete(item.id);
                return next;
            });
        }
    }, [dbInitialized, fetchSpotifyToken, updateMediaInDB, fetchingMetadataIds]); // Dependencies

    // Background Metadata Fetching (Web Only)
    const fetchMissingMetadataInBackground = useCallback(async () => {
        // Guard clauses: Web only, DB initialized, not already fetching, library has items
        if (Platform.OS !== 'web' || !dbInitialized || isFetchingMetadata || library.length === 0) return;

        const currentToken = await fetchSpotifyToken(); // Ensure token exists before starting
        if (!currentToken) {
            console.warn("Cannot start background metadata fetch, no valid Spotify token.");
            return;
        }

        // Find audio items that haven't been checked yet (spotifyChecked === 0)
        const itemsToFetch = library.filter(item => item.type === 'audio' && item.spotifyChecked === 0);

        if (itemsToFetch.length === 0) {
            // console.log("No items require background metadata fetch.");
            return; // Nothing to do
        }

        console.log(`Starting background metadata fetch for ${itemsToFetch.length} items...`);
        setIsFetchingMetadata(true); // Set flag to prevent concurrent runs

        try {
            for (const item of itemsToFetch) {
                // Double-check if another process started fetching this item
                if (!fetchingMetadataIds.has(item.id)) {
                    await searchSpotifyAndFetchMetadata(item);
                    // Add delay between requests to avoid hitting rate limits
                    await new Promise(resolve => setTimeout(resolve, BACKGROUND_METADATA_FETCH_DELAY));
                }
            }
            console.log("Background metadata fetch cycle complete.");
        } catch (error) {
            console.error("Error during background metadata fetch loop:", error);
        } finally {
            setIsFetchingMetadata(false); // Clear flag
        }
    }, [library, dbInitialized, isFetchingMetadata, fetchingMetadataIds, searchSpotifyAndFetchMetadata, fetchSpotifyToken]); // Dependencies

    // Effect to trigger background fetch when conditions are met
    useEffect(() => {
        // Trigger only on web, when DB is ready, token exists, and library has items
        if (Platform.OS === 'web' && dbInitialized && spotifyToken && library.length > 0) {
            // Use a timeout to delay the fetch slightly after initial load/library changes
            const timer = setTimeout(() => {
                fetchMissingMetadataInBackground();
            }, 3000); // Delay of 3 seconds

            return () => clearTimeout(timer); // Clear timeout on unmount or dependency change
        }
    }, [library, spotifyToken, dbInitialized, fetchMissingMetadataInBackground]); // Dependencies

    // --- Gemini API ---
    const fetchLyricsAndChordsFromGemini = useCallback(async (item) => {
        // Guard clauses: Web only, DB initialized, valid item, Gemini AI initialized
        if (Platform.OS !== 'web' || !dbInitialized || !item || !genAI) {
            Alert.alert("Feature Unavailable", "Lyrics fetching requires the Gemini API and is available only on the web platform.");
            return;
        }
        // Prevent concurrent fetches
        if (isFetchingLyrics) return;

        // If lyrics are already loaded in state for this item, just show the modal
        if (currentLyricsChords && currentMedia?.id === item.id) {
            setShowLyricsModal(true);
            return;
        }
        // If lyrics are stored in the item's DB data, load and show them
        if (item.lyricsChords) {
             setCurrentLyricsChords(item.lyricsChords);
             setShowLyricsModal(true);
             return;
        }

        console.log(`Fetching lyrics/chords for: ${item.trackName || item.name}`);
        setIsFetchingLyrics(true);
        setCurrentLyricsChords(''); // Clear previous lyrics
        setShowLyricsModal(true); // Show modal with loading indicator

        // Prepare prompt for Gemini
        const track = item.trackName || cleanFilenameForSearch(item.name); // Use cleaned name if trackName unavailable
        const artist = item.artistName || 'Unknown Artist';
        const prompt = `Provide the lyrics and guitar chords for the song "${track}" by "${artist}". If chords are not available or applicable, provide only the lyrics. Format the output clearly with chords above the corresponding lyrics line where appropriate. If you cannot find the lyrics or chords, respond ONLY with the exact text "Lyrics/Chords not found.". Do not add any conversational text before or after the lyrics/chords or the not found message.`;

        try {
            const model = genAI.getGenerativeModel({ model: GEMINI_MODEL_NAME });
            const result = await model.generateContent(prompt);
            const response = await result.response;
            let text = response.text().trim(); // Trim whitespace

            // Check if the response indicates not found
            if (text === "Lyrics/Chords not found." || text.length < 20) { // Also check for very short responses
                text = 'Lyrics/Chords not found.'; // Standardize not found message
                console.log(`Lyrics/Chords not found via Gemini for: ${track}`);
                 // Update DB to mark as checked (lyrics not found) - maybe add a specific field?
                 // For now, just don't save anything.
            } else {
                console.log(`Successfully fetched lyrics/chords via Gemini for: ${track}`);
                // Update the item in the DB with the fetched lyrics
                await updateMediaInDB(item.id, { lyricsChords: text });
            }
            // Update state with the result (either lyrics or "not found")
            setCurrentLyricsChords(text);

        } catch (error) {
            console.error("Error fetching lyrics from Gemini:", error);
            const errorMessage = `Error fetching lyrics: ${error.message}`;
            setCurrentLyricsChords(errorMessage); // Show error in the modal
            Alert.alert("Lyrics Error", errorMessage);
            // Don't update DB on error
        } finally {
            setIsFetchingLyrics(false); // Clear loading flag
        }
    }, [dbInitialized, currentMedia?.id, currentLyricsChords, isFetchingLyrics, updateMediaInDB]); // Dependencies

    // --- Playback Status Update Handler ---
    const onPlaybackStatusUpdate = useCallback((status) => {
        // console.log("onPlaybackStatusUpdate:", status); // Debug log
        if (!status) {
            // This case might happen on unload, ensure state is cleared
            setPlaybackStatus(null);
            return;
        }

        // Handle errors
        if (status.error) {
            console.error(`Playback Error: ${status.error}`);
            Alert.alert("Playback Error", status.error);
            // Stop playback and clear state on error
            handleStopPlayback(true); // Pass true to unload
            return; // Exit early
        }

        // Handle unload or unexpected state
        if (!status.isLoaded) {
            // If an error didn't cause this, it might be buffering or unloaded
            setPlaybackStatus(prevStatus => ({
                // Keep some previous state if available, but mark as not loaded/playing
                ...(prevStatus || {}),
                isLoaded: false,
                isPlaying: false,
                isBuffering: false, // Or maybe true if we expect it to load? Let's default to false.
                error: null, // Clear any previous error
                didJustFinish: false, // Reset finish flag
            }));
        } else {
            // Main update logic for loaded playback
            const newStatus = {
                isLoaded: true,
                isPlaying: status.isPlaying,
                isBuffering: status.isBuffering ?? false, // Handle potential undefined
                // Use duration from status if available and valid, fallback to media item, then 0
                durationMillis: (status.durationMillis && Number.isFinite(status.durationMillis)) ? status.durationMillis : (currentMedia?.durationMillis || 0),
                positionMillis: status.positionMillis ?? 0,
                rate: status.rate ?? rate, // Use status rate or fallback to state rate
                volume: status.volume ?? volume, // Use status volume or fallback to state volume
                isLooping: status.isLooping ?? isLooping, // Use status loop or fallback to state loop
                didJustFinish: status.didJustFinish ?? false,
                error: null, // Clear error on successful status update
            };
            setPlaybackStatus(newStatus);

            // Handle track finishing (if not looping)
            if (status.didJustFinish && !newStatus.isLooping) {
                console.log("Track finished, playing next.");
                // Use requestAnimationFrame to ensure state update completes before triggering next
                requestAnimationFrame(() => handleNextTrack());
            }
        }
    }, [currentMedia?.id, currentMedia?.durationMillis, isLooping, rate, volume, handleNextTrack, handleStopPlayback]); // Added dependencies


    // --- Build Playback Queue ---
    // Builds a queue based on either an explicit list (playlist) or the current library view
    const buildPlaybackQueue = useCallback((baseList = library, params = currentViewParams, explicitQueue = null) => {
        console.log("Building playback queue. Explicit queue provided:", !!explicitQueue);

        let queueSource;
        let sourceDescription;

        // 1. Determine the source list for the queue
        if (explicitQueue && Array.isArray(explicitQueue)) {
            // Use the explicitly provided queue (e.g., from playlist detail)
            queueSource = explicitQueue;
            sourceDescription = `explicit queue (${explicitQueue.length} items)`;
        } else {
            // Build queue based on the current view parameters (filter/sort/search) applied to the base list (usually full library)
            sourceDescription = `view params (Filter: ${params.filterType}, Sort: ${params.sort}, Search: "${params.searchQuery}")`;
            let results = baseList;
            const { filterType, sort, searchQuery } = params;

            // Filter by Tab Type
            if (filterType !== 'all') {
                if (filterType === 'favorites') {
                    results = results.filter(item => !!item.isFavorite);
                } else {
                    results = results.filter(item => item.type === filterType);
                }
            }

            // Filter by Search Query
            if (searchQuery) {
                const queryLower = searchQuery.toLowerCase().trim();
                if (queryLower) {
                    results = results.filter(item => {
                        const name = (item.name || '').toLowerCase();
                        const trackName = (item.trackName || '').toLowerCase();
                        const artistName = (item.artistName || '').toLowerCase();
                        const albumName = (item.albumName || '').toLowerCase();
                        return name.includes(queryLower) || trackName.includes(queryLower) || artistName.includes(queryLower) || albumName.includes(queryLower);
                    });
                }
            }

            // Sort Results
            if (Platform.OS === 'web') {
                results = sortWebData(results, sort); // Use the memoized web sort function
            } else {
                 results = [...results]; // Copy before sorting
                 if (sort.startsWith('addedDate')) {
                     results.sort((a, b) => (b.addedDate ?? 0) - (a.addedDate ?? 0)); // Newest first
                 } else { // Default name sort
                     results.sort((a, b) => (a.name ?? '').localeCompare(b.name ?? '', undefined, { sensitivity: 'base' }));
                 }
            }
            queueSource = results;
        }

        // 2. Filter out non-playable items (audio/video) from the determined source
        const playableQueue = queueSource.filter(item => item.type === 'audio' || item.type === 'video');

        // 3. Update state
        setPlaybackQueue(playableQueue);

        // 4. Update current index based on currentMedia within the *new* queue
        let newIndex = -1;
        if (currentMedia) {
            newIndex = playableQueue.findIndex(item => item.id === currentMedia.id);
        }
        setCurrentQueueIndex(newIndex);

        console.log(`Queue built from ${sourceDescription}. Size: ${playableQueue.length}. Current index: ${newIndex}`);
        return playableQueue; // Return the generated playable queue

    }, [library, currentViewParams, currentMedia?.id, sortWebData]); // Dependencies

    // Effect to rebuild queue when view params or library change,
    // but *only* if no explicit queue was just set (heuristic).
    useEffect(() => {
        // This effect rebuilds the queue based on the *view* when the view changes.
        // It should NOT run if we just played something from an *explicit* queue (like a playlist).
        // The `loadAndPlayMedia` function handles setting the explicit queue.
        // We assume if the current media exists and is *not* found in the queue derived
        // from the current view params, then an explicit queue is likely active.
        // This is an indirect way to manage this; a dedicated flag might be more robust.

        // Build a temporary queue based on current view to check against
        const viewBasedQueue = buildPlaybackQueue(library, currentViewParams); // This call updates state, but we use the return value here

        // If currentMedia exists, check if it's in the queue derived from the view
        if (currentMedia) {
            const indexInViewQueue = viewBasedQueue.findIndex(item => item.id === currentMedia.id);
            if (indexInViewQueue === -1) {
                // Current media is not in the view-based queue. Assume an explicit queue is active.
                // Do nothing, let the explicit queue persist.
                // console.log("Current media not in view-based queue, likely explicit queue active. Skipping view-based rebuild.");
            } else {
                // Current media *is* in the view-based queue. Ensure the state reflects this.
                // The buildPlaybackQueue call above already updated the state.
                // console.log("View params changed, queue rebuilt based on view.");
            }
        } else {
             // No current media, ensure queue reflects the current view.
             // The buildPlaybackQueue call above already updated the state.
             // console.log("No current media, queue rebuilt based on view.");
        }

    }, [library, currentViewParams, buildPlaybackQueue]); // Rebuild only when library or view params change


    // --- Load and Play Media ---
    const loadAndPlayMedia = useCallback(async (item, playImmediately = true, explicitQueue = null) => {
        // Basic validation
        if (!item || !item.uri) {
            console.error("loadAndPlayMedia: Invalid item or missing URI.", item);
            Alert.alert("Error", "Cannot play the selected item (invalid data or URI).");
            return;
        }
        // Avoid reloading the same item if already loading
        if (isLoading && currentMedia?.id === item.id) {
            console.log("loadAndPlayMedia: Already loading this item, ignoring request.");
            return;
        }

        console.log(`Loading media: ${item.name} (ID: ${item.id}, Type: ${item.type}, Play: ${playImmediately}, Explicit Queue: ${!!explicitQueue})`);
        setIsLoading(true); // Set loading flag
        setPlaybackStatus(null); // Clear previous status
        setCurrentLyricsChords(''); // Clear lyrics

        // Stop and unload any previous playback instance *before* setting new media
        await handleStopPlayback(true); // Pass true to unload

        // Set the new media item
        setCurrentMedia(item);

        // --- Build/Set Playback Queue ---
        // This call sets the playbackQueue state and currentQueueIndex state
        // It uses the explicitQueue if provided, otherwise builds from the current view.
        const newQueue = buildPlaybackQueue(library, currentViewParams, explicitQueue);
        // Note: currentQueueIndex is set inside buildPlaybackQueue now.

        try {
            // Handle playable types (Audio/Video)
            if (item.type === 'audio' || item.type === 'video') {
                // Reset EQ for audio tracks
                if (item.type === 'audio') {
                    handleResetEq();
                }

                // Set initial buffering status
                setPlaybackStatus({
                    isLoaded: false, isPlaying: false, isBuffering: true,
                    durationMillis: item.durationMillis || 0, positionMillis: 0,
                    rate: rate, volume: volume, isLooping: isLooping, error: null
                });

                // Platform-specific loading
                if (Platform.OS === 'web') {
                    console.log("Web platform: Delegating load to WebAudioPlayer component via state change.");
                    // The WebAudioPlayer useEffect hook will detect the change in `currentMedia`
                    // and update the <audio> element's src, triggering the load.
                    // We need to ensure the <audio>/<video> element exists and is ready.
                    const audioElement = webAudioElementRef.current;
                    if (audioElement) {
                        // Set src and other properties directly here as well for immediate effect
                        if (audioElement.src !== item.uri) {
                            audioElement.src = item.uri;
                            audioElement.load(); // Important to call load()
                        }
                        audioElement.playbackRate = rate;
                        audioElement.loop = isLooping;
                        if (playImmediately) {
                             // Attempt to play, might require user interaction initially
                             audioElement.play().catch(e => console.warn("Web Audio play() failed:", e));
                        }
                    } else {
                        console.error("Web audio element ref not found!");
                        throw new Error("Web audio element not ready.");
                    }

                } else {
                    // Native platform: Use Expo AV
                    console.log("Native platform: Loading with Expo AV...");
                    const soundObject = new Audio.Sound();
                    // Set status update callback *before* loading
                    soundObject.setOnPlaybackStatusUpdate(onPlaybackStatusUpdate);

                    const initialStatus = {
                        shouldPlay: playImmediately,
                        volume: volume,
                        rate: rate,
                        isLooping: isLooping,
                        progressUpdateIntervalMillis: 500 // How often to get status updates
                    };

                    // Load the media source
                    await soundObject.loadAsync(
                        { uri: item.uri },
                        initialStatus,
                        true // downloadFirst - Set to true for potentially better performance/seeking? Test this.
                    );
                    setPlaybackInstance(soundObject); // Store the sound object instance
                    console.log("Native media loaded successfully.");
                }

                // Update last played timestamp (Web only, using DB)
                if (Platform.OS === 'web' && dbInitialized) {
                    updateMediaInDB(item.id, { lastPlayed: Math.floor(Date.now() / 1000) });
                }
                // Trigger metadata fetch if needed (Web only, audio, not checked)
                if (Platform.OS === 'web' && item.type === 'audio' && item.spotifyChecked === 0 && dbInitialized) {
                    // Don't await this, let it run in the background
                    searchSpotifyAndFetchMetadata(item);
                }

            } else if (item.type === 'image') {
                // Handle Image type: Show Image Viewer
                console.log("Loading image viewer...");
                // Build image list based on the *current playback queue source* (either explicit or view-based)
                // Filter this source for images only.
                const currentContextImages = newQueue // Use the queue generated above
                                          .filter(libItem => libItem.type === 'image'); // Filter for images

                // Find the index of the selected image within this context
                const imageIndex = currentContextImages.findIndex(img => img.id === item.id);

                if (imageIndex !== -1) {
                    setImageViewerList(currentContextImages); // Set the list for the viewer
                    setImageViewerIndex(imageIndex); // Set the starting index
                    setShowImageViewer(true); // Show the modal
                } else {
                    // Fallback: If the image wasn't in the expected queue (shouldn't happen often)
                    // just show the single image.
                    console.warn("Selected image not found in the current context queue. Showing single image.");
                    setImageViewerList([item]);
                    setImageViewerIndex(0);
                    setShowImageViewer(true);
                }
                // Clear currentMedia state as image viewer handles its own state
                setCurrentMedia(null);
                // Ensure loading indicator is turned off
                setIsLoading(false); // Explicitly set loading false here

            } else if (item.type === 'document' || item.type === 'lyrics') {
                // Handle Document/Lyrics types
                console.log(`Handling ${item.type}:`, item.name);
                if (Platform.OS === 'web') {
                    // Open in new tab on web
                    try { window.open(item.uri, '_blank'); } catch (e) { Alert.alert("Open Failed", `Could not open the ${item.type}. Ensure pop-ups are allowed.`); }
                } else {
                    // Native support might require linking or a dedicated viewer library
                    Alert.alert("Unsupported Action", `Opening ${item.type} files directly is not supported on this platform yet.`);
                }
                // Clear currentMedia and loading state
                setCurrentMedia(null);
                setIsLoading(false);

            } else {
                // Handle Unknown/Unsupported types
                Alert.alert("Unsupported Type", `Cannot play files of type: ${item.type || 'unknown'}`);
                setCurrentMedia(null);
                setIsLoading(false);
            }

        } catch (error) {
            console.error(`Error loading media ${item.name} (ID: ${item.id}):`, error);
            Alert.alert("Load Error", `Could not load the selected media: ${error.message}`);
            await handleStopPlayback(true); // Unload on error
            setCurrentMedia(null); // Clear media state
            setPlaybackStatus({ isLoaded: false, isPlaying: false, isBuffering: false, error: error.message }); // Set error status
        } finally {
            // Ensure loading is turned off *unless* it's audio/video which might still be buffering
            if (item.type !== 'audio' && item.type !== 'video') {
                 setIsLoading(false);
            }
            // For audio/video, the onPlaybackStatusUpdate will handle setting isLoading=false
            // once buffering finishes or an error occurs. We leave isLoading=true for now.
        }
    }, [
        isLoading, currentMedia?.id, playbackInstance, onPlaybackStatusUpdate,
        searchSpotifyAndFetchMetadata, updateMediaInDB, dbInitialized, volume, rate,
        isLooping, library, currentViewParams, handleStopPlayback, handleResetEq,
        buildPlaybackQueue // Added dependencies
    ]);

    // --- Playback Controls ---
    const handlePlayPause = useCallback(async () => {
        // Guard clauses: Check if media is loaded or loading
        if (isLoading || !currentMedia || !playbackStatus) {
            console.log("Play/Pause ignored: No media, loading, or no status.");
            return;
        }

        if (Platform.OS === 'web') {
            const audioElement = webAudioElementRef.current;
            if (!audioElement) {
                console.error("Web audio element not found for play/pause.");
                return;
            }
            try {
                if (playbackStatus.isPlaying) {
                    audioElement.pause();
                    console.log("Web audio paused.");
                } else {
                    // Resume AudioContext if suspended (required by browser policy)
                    if (audioContextRef.current && audioContextRef.current.state === 'suspended') {
                        await audioContextRef.current.resume();
                        console.log("Web AudioContext resumed.");
                    }
                    await audioElement.play();
                    console.log("Web audio playing.");
                }
                // Status update will be triggered by element events
            } catch (error) {
                console.error("Error during web play/pause:", error);
                Alert.alert("Playback Error", `Could not ${playbackStatus.isPlaying ? 'pause' : 'play'}: ${error.message}`);
            }
        } else {
            // Native playback control
            if (!playbackInstance || !playbackStatus.isLoaded) {
                 console.log("Native play/pause ignored: Instance not ready or not loaded.");
                 return;
            }
            try {
                if (playbackStatus.isPlaying) {
                    await playbackInstance.pauseAsync();
                    console.log("Native audio paused.");
                } else {
                    await playbackInstance.playAsync();
                    console.log("Native audio playing.");
                }
                // Status update will be triggered by setOnPlaybackStatusUpdate callback
            } catch (error) {
                console.error("Error during native play/pause:", error);
                Alert.alert("Playback Error", `Could not ${playbackStatus.isPlaying ? 'pause' : 'play'}: ${error.message}`);
            }
        }
    }, [isLoading, currentMedia, playbackStatus, playbackInstance]); // Dependencies

    const handleSeek = useCallback(async (positionMillis) => {
        // Guard clauses: Check if seek is possible
        if (isLoading || !currentMedia || !playbackStatus || !playbackStatus.isLoaded) {
             console.log("Seek ignored: Not ready or not loaded.");
             return;
        }
        const duration = playbackStatus.durationMillis || 0;
        if (duration <= 0 || !Number.isFinite(duration)) {
            console.log("Seek ignored: Invalid duration.");
            return;
        }

        // Clamp seek position within bounds [0, duration]
        const seekPosition = Math.max(0, Math.min(positionMillis, duration));
        console.log(`Seeking to ${formatTime(seekPosition)} / ${formatTime(duration)}`);

        if (Platform.OS === 'web') {
            const audioElement = webAudioElementRef.current;
            if (audioElement) {
                try {
                    audioElement.currentTime = seekPosition / 1000; // Web Audio uses seconds
                    // Manually update status position immediately for better responsiveness
                    setPlaybackStatus(prev => prev ? { ...prev, positionMillis: seekPosition } : null);
                } catch (error) {
                    console.error("Error seeking web audio:", error);
                }
            }
        } else {
            // Native playback control
            if (playbackInstance) {
                try {
                    await playbackInstance.setPositionAsync(seekPosition);
                    // Status update will be triggered by callback
                } catch (error) {
                    console.error("Error seeking native audio:", error);
                    // Handle specific errors? e.g., seeking not allowed
                }
            }
        }
    }, [isLoading, currentMedia, playbackStatus, playbackInstance]); // Dependencies

    // Stops playback and optionally unloads resources
    const handleStopPlayback = useCallback(async (shouldUnload = true) => {
        console.log(`Stopping playback. Unload: ${shouldUnload}`);

        // Stop Web Playback
        if (Platform.OS === 'web') {
            const audioElement = webAudioElementRef.current;
            if (audioElement) {
                audioElement.pause();
                if (shouldUnload) {
                    // Clear source and reset
                    audioElement.removeAttribute('src');
                    audioElement.load(); // Reset element state
                    console.log("Web audio source cleared.");
                    // Disconnect the source node from the graph if it exists
                    if (audioSourceNodeRef.current) {
                        try { audioSourceNodeRef.current.disconnect(); } catch(e) { /* Ignore */ }
                        audioSourceNodeRef.current = null; // Clear the ref
                        console.log("Web audio source node disconnected.");
                    }
                } else {
                    // If not unloading, just seek to beginning
                    audioElement.currentTime = 0;
                }
            }
        } else {
            // Stop Native Playback
            if (playbackInstance) {
                try {
                    // Check if it's actually loaded/playing before stopping
                    const status = await playbackInstance.getStatusAsync();
                    if (status.isLoaded) {
                        await playbackInstance.stopAsync();
                        console.log("Native playback stopped.");
                        if (shouldUnload) {
                            await playbackInstance.unloadAsync();
                            setPlaybackInstance(null); // Clear the instance ref
                            console.log("Native playback instance unloaded.");
                        }
                    } else if (shouldUnload) {
                         // If not loaded but should unload, ensure instance is cleared
                         setPlaybackInstance(null);
                         console.log("Native playback instance was not loaded, cleared ref.");
                    }
                } catch (error) {
                    console.error("Error stopping/unloading native instance:", error);
                    // Force clear instance ref even on error during unload
                    if (shouldUnload) setPlaybackInstance(null);
                }
            }
        }

        // Clear state if unloading
        if (shouldUnload) {
            setCurrentMedia(null);
            setPlaybackStatus(null);
            setCurrentQueueIndex(-1); // Reset queue index
            setIsPlayerFullScreen(false); // Close full screen player
            setCurrentLyricsChords(''); // Clear lyrics
            setPlaybackQueue([]); // Clear the queue itself
            console.log("Playback state cleared.");
        } else {
             // If just stopping (not unloading), update status to reflect stopped state
             setPlaybackStatus(prev => prev ? { ...prev, isPlaying: false, positionMillis: 0 } : null);
        }
    }, [playbackInstance]); // Dependency: playbackInstance

    const handleNextTrack = useCallback(() => {
        console.log(`handleNextTrack called. Queue length: ${playbackQueue.length}, Current index: ${currentQueueIndex}`);
        // Check if queue is valid and there is a next track
        if (playbackQueue.length === 0 || currentQueueIndex === -1 || currentQueueIndex >= playbackQueue.length - 1) {
            console.log("Next track: No next track available or queue invalid. Stopping.");
            handleStopPlayback(true); // Stop and unload if at end or invalid state
            return;
        }

        const nextIndex = currentQueueIndex + 1;
        const nextMedia = playbackQueue[nextIndex];
        console.log(`Playing next track: ${nextMedia.name} (Index: ${nextIndex})`);
        // Load and play the next media item, passing the *current* queue as the explicit queue
        // to maintain the playback context.
        loadAndPlayMedia(nextMedia, true, playbackQueue);

    }, [currentQueueIndex, playbackQueue, loadAndPlayMedia, handleStopPlayback]); // Dependencies

    const handlePreviousTrack = useCallback(() => {
        console.log(`handlePreviousTrack called. Queue length: ${playbackQueue.length}, Current index: ${currentQueueIndex}`);
        const seekThreshold = 3000; // 3 seconds threshold to restart vs. go back

        // If played for more than threshold, restart current track
        if (playbackStatus?.positionMillis > seekThreshold && currentQueueIndex !== -1) {
            console.log("Previous track: Restarting current track.");
            handleSeek(0); // Seek to beginning
        } else {
            // Otherwise, go to the actual previous track if available
            if (playbackQueue.length === 0 || currentQueueIndex <= 0) {
                console.log("Previous track: No previous track available or queue invalid.");
                // Optionally seek to 0 if already at the first track
                if (currentQueueIndex === 0) handleSeek(0);
                return;
            }
            const prevIndex = currentQueueIndex - 1;
            const prevMedia = playbackQueue[prevIndex];
            console.log(`Playing previous track: ${prevMedia.name} (Index: ${prevIndex})`);
            // Load and play the previous media item, passing the current queue
            loadAndPlayMedia(prevMedia, true, playbackQueue);
        }
    }, [currentQueueIndex, playbackQueue, loadAndPlayMedia, handleSeek, playbackStatus?.positionMillis]); // Dependencies

    // --- Volume/Rate/Loop Controls ---
    const handleVolumeChange = useCallback(async (newVolume) => {
        const clampedVolume = Math.max(0, Math.min(1, newVolume)); // Ensure volume is 0-1
        setVolume(clampedVolume); // Update state immediately for UI responsiveness

        if (Platform.OS === 'web') {
            // Update Web Audio API GainNode
            if (gainNodeRef.current && audioContextRef.current) {
                // Use setTargetAtTime for smooth transition
                gainNodeRef.current.gain.setTargetAtTime(clampedVolume, audioContextRef.current.currentTime, 0.015); // Short ramp time
            }
             // Update playback status state as well
             setPlaybackStatus(prev => prev ? { ...prev, volume: clampedVolume } : null);
        } else if (playbackInstance && playbackStatus?.isLoaded) {
            // Update Native playback instance
            try {
                await playbackInstance.setVolumeAsync(clampedVolume);
                // Status update callback will reflect the change
            } catch (error) {
                console.error("Error setting native volume:", error);
            }
        }
    }, [playbackInstance, playbackStatus?.isLoaded]); // Dependencies

    const handleRateChange = useCallback(async () => {
        const rates = [0.75, 1.0, 1.25, 1.5, 2.0]; // Cycle through these rates
        const currentIndex = rates.findIndex(r => Math.abs(r - rate) < 0.01); // Find current rate index
        const nextRate = rates[(currentIndex + 1) % rates.length]; // Get next rate in cycle

        setRate(nextRate); // Update state
        console.log(`Setting rate to: ${nextRate}`);

        if (Platform.OS === 'web') {
            const audioElement = webAudioElementRef.current;
            if (audioElement) audioElement.playbackRate = nextRate;
             // Update playback status state
             setPlaybackStatus(prev => prev ? { ...prev, rate: nextRate } : null);
        } else if (playbackInstance && playbackStatus?.isLoaded) {
            try {
                // Set rate, maintain pitch (shouldPitchCorrect = true)
                await playbackInstance.setRateAsync(nextRate, true);
                // Status update callback will reflect the change
            } catch (error) {
                console.error("Error setting native rate:", error);
            }
        }
    }, [rate, playbackInstance, playbackStatus?.isLoaded]); // Dependencies

    const handleLoopToggle = useCallback(async () => {
        const nextIsLooping = !isLooping;
        setIsLooping(nextIsLooping); // Update state
        console.log(`Setting loop to: ${nextIsLooping}`);

        if (Platform.OS === 'web') {
            const audioElement = webAudioElementRef.current;
            if (audioElement) audioElement.loop = nextIsLooping;
             // Update playback status state
             setPlaybackStatus(prev => prev ? { ...prev, isLooping: nextIsLooping } : null);
        } else if (playbackInstance && playbackStatus?.isLoaded) {
            try {
                await playbackInstance.setIsLoopingAsync(nextIsLooping);
                // Status update callback will reflect the change
            } catch (error) {
                console.error("Error setting native loop status:", error);
            }
        }
    }, [isLooping, playbackInstance, playbackStatus?.isLoaded]); // Dependencies

    // --- EQ Controls ---
    const handleEqGainChange = useCallback((bandIndex, gainDb) => {
        // Update EQ gains state
        const newGains = [...eqGains];
        newGains[bandIndex] = gainDb;
        setEqGains(newGains);

        // Apply gain change to Web Audio API node if applicable
        if (Platform.OS === 'web' && eqNodesRef.current[bandIndex] && audioContextRef.current) {
            // Use setTargetAtTime for smooth gain changes
            eqNodesRef.current[bandIndex].gain.setTargetAtTime(gainDb, audioContextRef.current.currentTime, 0.02); // Short ramp
        }
    }, [eqGains]); // Dependency: eqGains state

    const handleResetEq = useCallback(() => {
        const defaultGains = Array(EQ_BANDS.length).fill(0); // Array of zeros
        setEqGains(defaultGains); // Reset state

        // Reset Web Audio API nodes if applicable
        if (Platform.OS === 'web' && audioContextRef.current) {
            console.log("Resetting EQ gains");
            eqNodesRef.current.forEach((node) => {
                if (node) {
                    // Smoothly ramp gain back to 0
                    node.gain.setTargetAtTime(0, audioContextRef.current.currentTime, 0.02);
                }
            });
        }
    }, []); // No dependencies needed

    // --- File Handling (Web ONLY - File Picker) ---
    const pickFiles = useCallback(async () => {
        // Guard clauses: Web only, DB ready, not already loading
        if (Platform.OS !== 'web' || isDbLoading || !dbInitialized) return;

        console.log("Opening file picker...");
        try {
            // Create a hidden file input element
            const input = document.createElement('input');
            input.type = 'file';
            input.multiple = true; // Allow multiple file selection
            // Define accepted file types (MIME types or extensions)
            input.accept = "audio/*,video/*,image/*,.pdf,.doc,.docx,.txt,.xls,.xlsx,.ppt,.pptx,.rtf,.csv,.lrc";

            // Handle file selection
            input.onchange = async (event) => {
                const files = event.target.files;
                if (!files || files.length === 0) {
                    console.log("No files selected.");
                    return; // Exit if no files chosen
                }

                console.log(`Processing ${files.length} selected files...`);
                setIsDbLoading(true); // Show loading indicator
                let addedCount = 0;
                const newItemsForState = []; // Collect newly added items for state update

                for (const file of files) {
                    const fileType = getFileType(file); // Determine file type
                    if (fileType === 'unknown') {
                        console.warn(`Skipping unknown file type: ${file.name}`);
                        continue; // Skip unsupported types
                    }

                    let uri = null;
                    let durationMillis = null;
                    let newItemData = null;

                    try {
                        // Create a Blob and Object URL for the file
                        // Note: Object URLs should be revoked when no longer needed (e.g., on delete, app close)
                        const blob = new Blob([file], { type: file.type });
                        uri = URL.createObjectURL(blob);

                        // Attempt to get duration for audio/video using a temporary element
                        if (fileType === 'audio' || fileType === 'video') {
                            try {
                                const tempElement = document.createElement(fileType); // Create <audio> or <video>
                                durationMillis = await new Promise((resolve, reject) => {
                                    // Timeout to prevent hanging if metadata never loads
                                    let timeoutId = setTimeout(() => {
                                        tempElement.onerror = null; // Clear handlers
                                        tempElement.onloadedmetadata = null;
                                        reject(new Error(`Metadata load timeout for ${file.name}`));
                                    }, METADATA_LOAD_TIMEOUT);

                                    tempElement.onloadedmetadata = () => {
                                        clearTimeout(timeoutId);
                                        resolve(Math.floor(tempElement.duration * 1000)); // Duration in ms
                                    };
                                    tempElement.onerror = (e) => {
                                        clearTimeout(timeoutId);
                                        console.error(`Metadata load error for ${file.name}:`, tempElement.error);
                                        reject(new Error(`Metadata load error: ${tempElement.error?.message || 'Unknown'}`));
                                    };
                                    tempElement.src = uri; // Set src to trigger loading
                                    tempElement.load(); // Explicitly call load
                                });
                            } catch (metaError) {
                                console.warn(`Could not get duration for ${file.name}: ${metaError.message}`);
                                durationMillis = null; // Set duration to null if failed
                            }
                        }

                        // Prepare item data for DB insertion
                        newItemData = {
                            name: file.name,
                            uri: uri, // Store the blob URI
                            type: fileType,
                            durationMillis: durationMillis,
                            addedDate: Math.floor(Date.now() / 1000),
                            // Initialize other fields with defaults
                            isFavorite: 0, lastPlayed: null, spotifyChecked: 0, spotifyId: null,
                            artistName: null, albumName: null, trackName: null, coverArtUrl: null, lyricsChords: null,
                        };

                        // Add the item to IndexedDB
                        const addedItem = await addMediaToDB(newItemData);

                        if (addedItem) {
                            addedCount++;
                            // Add to list for state update (ensure isFavorite is boolean)
                            newItemsForState.push({...addedItem, isFavorite: !!addedItem.isFavorite});
                        } else {
                            // If addMediaToDB failed (e.g., duplicate), revoke the URL
                            if (uri) URL.revokeObjectURL(uri);
                            uri = null; // Prevent potential memory leaks
                        }

                    } catch (fileError) {
                        console.error(`Error processing file ${file.name}:`, fileError);
                        // Revoke URL if created but processing failed
                        if (uri) try { URL.revokeObjectURL(uri); } catch(e) { /* Ignore revoke error */ }
                    }
                } // End of file loop

                // Update library state with newly added items
                if (newItemsForState.length > 0) {
                    setLibrary(prev => [...prev, ...newItemsForState]);
                }

                console.log(`Finished processing files. Added ${addedCount} new items.`);
                setIsDbLoading(false); // Hide loading indicator

                // Trigger background metadata fetch if any audio files were added
                if (addedCount > 0 && newItemsForState.some(item => item.type === 'audio')) {
                    fetchMissingMetadataInBackground();
                }
            }; // End of input.onchange

            // Trigger the file picker dialog
            input.click();

        } catch (error) {
            console.error("Error setting up file picker:", error);
            Alert.alert("Error", "Could not open file picker.");
            setIsDbLoading(false); // Ensure loading indicator is off
        }
    }, [isDbLoading, dbInitialized, addMediaToDB, fetchMissingMetadataInBackground, setLibrary]); // Dependencies

    // --- File Handling (Native ONLY - Document Picker) ---
    const handlePickDocument = useCallback(async () => {
        if (Platform.OS === 'web') return; // Native only

        // Optional: Check MediaLibrary permissions first? DocumentPicker might work independently.
        // const hasPermission = await checkAndRequestPermissions();
        // if (!hasPermission) return;

        console.log("Opening native document picker...");
        try {
            const result = await DocumentPicker.getDocumentAsync({
                type: ["audio/*", "video/*", "image/*"], // Specify desired MIME types
                multiple: true, // Allow selecting multiple files
                copyToCacheDirectory: false, // Try to use original URI (might be content://) - potentially less reliable? Test this.
                                            // Setting to true might be more reliable but uses more space temporarily.
            });

            // console.log("Document Picker Result:", JSON.stringify(result, null, 2)); // Detailed log

            if (result.canceled) {
                console.log("Document picking cancelled.");
                return;
            }

            if (result.assets && result.assets.length > 0) {
                console.log(`Processing ${result.assets.length} selected assets...`);
                setIsLoading(true); // Use general loading indicator

                const newItems = [];
                for (const asset of result.assets) {
                    // Ensure URI exists
                    if (!asset.uri) {
                        console.warn(`Skipping asset with no URI: ${asset.name}`);
                        continue;
                    }

                    // Determine file type from MIME type or name
                    const fileType = getFileType(asset); // Pass the whole asset object
                    if (fileType === 'unknown') {
                        console.warn(`Skipping unknown file type: ${asset.name} (MIME: ${asset.mimeType})`);
                        continue;
                    }

                    // Attempt to get duration for audio/video using expo-av
                    let durationMillis = null;
                    if ((fileType === 'audio' || fileType === 'video')) {
                        let sound = null;
                        try {
                            console.log(`Attempting to get duration for ${asset.name}`);
                            // Create sound object just to get status, don't play
                            const { sound: tempSound, status } = await Audio.Sound.createAsync(
                                { uri: asset.uri },
                                { shouldPlay: false }
                                // downloadFirst: false // Don't download if not necessary for duration
                            );
                            sound = tempSound; // Keep ref for unloading
                            if (status.isLoaded && status.durationMillis) {
                                durationMillis = status.durationMillis;
                                console.log(`Got duration: ${durationMillis}ms`);
                            } else {
                                console.warn("Could not get duration from status for:", asset.name);
                            }
                        } catch (e) {
                            console.warn(`Error getting duration for ${asset.name}: ${e.message}`);
                        } finally {
                            // Ensure sound object is unloaded
                            if (sound) {
                                await sound.unloadAsync().catch(unloadError => console.warn("Error unloading temp sound:", unloadError));
                            }
                        }
                    }

                    // Create the item object for the library state
                    const newItem = {
                        // Generate a unique ID for manually added native items
                        id: `manual_${generateUniqueId()}`,
                        name: asset.name || `Unnamed ${fileType}`,
                        uri: asset.uri, // The URI from the picker
                        type: fileType,
                        durationMillis: durationMillis,
                        // Use lastModifiedDate or fallback to now for addedDate
                        addedDate: Math.floor((asset.lastModifiedDate || Date.now()) / 1000),
                        isFavorite: false, // Default to not favorite
                        // Initialize other fields expected by the app
                        spotifyChecked: 0, lastPlayed: null, lyricsChords: null, spotifyId: null,
                        artistName: null, albumName: null, trackName: null, coverArtUrl: null,
                    };
                    newItems.push(newItem);
                } // End asset loop

                // Add the new items to the existing library state (session-based)
                if (newItems.length > 0) {
                    setLibrary(prev => [...prev, ...newItems]);
                    console.log(`Added ${newItems.length} manually picked items to the session library.`);
                }
                setIsLoading(false); // Turn off loading indicator

            } else {
                console.log("No assets selected or returned from document picker.");
            }

        } catch (error) {
            console.error("Error picking documents:", error);
            // Check for specific Expo DocumentPicker errors if needed
            Alert.alert("Error", "Could not open file picker or process selected files.");
            setIsLoading(false); // Ensure loading is off
        }
    }, [setLibrary]); // Dependency: setLibrary


    // --- Deletion ---
    const handleDeleteMedia = useCallback(async (itemToDelete) => {
        if (!itemToDelete?.id) {
            console.warn("handleDeleteMedia called with invalid item.");
            return;
        }
        const itemName = itemToDelete.trackName || itemToDelete.name || 'this item';
        const message = Platform.OS === 'web'
            ? `Permanently remove "${itemName}" from your library and all playlists? This cannot be undone.`
            : `Remove "${itemName}" from this session's list, favorites, and playlists?`;

        Alert.alert("Confirm Removal", message, [
            { text: "Cancel", style: "cancel" },
            {
                text: Platform.OS === 'web' ? "Delete Permanently" : "Remove",
                style: "destructive",
                onPress: async () => {
                    console.log(`Attempting to delete/remove item: ${itemName} (ID: ${itemToDelete.id})`);

                    // 1. Stop playback if it's the current item
                    if (currentMedia?.id === itemToDelete.id) {
                        await handleStopPlayback(true); // Unload the player
                    }

                    let success = false;
                    // 2. Platform-specific deletion logic
                    if (Platform.OS === 'web') {
                        // Revoke blob URL if it exists
                        if (itemToDelete.uri?.startsWith('blob:')) {
                            try { URL.revokeObjectURL(itemToDelete.uri); console.log("Revoked blob URL for deleted item."); } catch(e) { console.warn("Error revoking blob URL:", e); }
                        }
                        // Delete from IndexedDB media store
                        success = await deleteMediaFromDB(itemToDelete.id);

                        // Also remove track ID from all playlists in IndexedDB
                        if (success) {
                            console.log(`Removing track ${itemToDelete.id} from all web playlists...`);
                            const currentPlaylists = await dbInstancePromise.then(db => db.getAll(PLAYLIST_STORE_NAME));
                            const updatePromises = currentPlaylists.map(p => {
                                const updatedTrackIds = (p.trackIds || []).filter(tid => tid !== itemToDelete.id);
                                // Only update if the track was actually in the playlist
                                if (updatedTrackIds.length !== (p.trackIds || []).length) {
                                    return updatePlaylist(p.id, { trackIds: updatedTrackIds });
                                }
                                return Promise.resolve(); // No update needed
                            });
                            await Promise.all(updatePromises);
                            // Reload playlists state from DB after updates
                            await loadPlaylists();
                        }
                    } else {
                        // Native: No persistent DB deletion, just remove from session state and persistent lists (favs/playlists)
                        success = true; // Assume success for state removal

                        // Remove from favorites (AsyncStorage)
                        if (favoriteIds.has(itemToDelete.id)) {
                            const newFavs = new Set(favoriteIds);
                            newFavs.delete(itemToDelete.id);
                            setFavoriteIds(newFavs); // Update state
                            await saveFavoritesToStorage(newFavs); // Persist change
                            console.log(`Removed ${itemToDelete.id} from native favorites.`);
                        }

                        // Remove from playlists (AsyncStorage)
                        let playlistsModified = false;
                        const updatedNativePlaylists = playlists.map(p => {
                            const updatedTrackIds = (p.trackIds || []).filter(tid => tid !== itemToDelete.id);
                            if (updatedTrackIds.length !== (p.trackIds || []).length) {
                                playlistsModified = true;
                                return { ...p, trackIds: updatedTrackIds };
                            }
                            return p;
                        });
                        if (playlistsModified) {
                            await savePlaylists(updatedNativePlaylists); // savePlaylists updates state and saves
                            console.log(`Removed ${itemToDelete.id} from native playlists.`);
                        }
                    }

                    // 3. Update UI: Remove from library state
                    if (success) {
                        setLibrary(prevLibrary => prevLibrary.filter(item => item.id !== itemToDelete.id));
                        console.log(`Successfully removed ${itemName} from library state.`);
                        // Also remove from current playback queue if present
                        setPlaybackQueue(prevQueue => prevQueue.filter(item => item.id !== itemToDelete.id));
                    } else {
                        console.error(`Failed to complete deletion/removal process for ${itemName}.`);
                        Alert.alert("Error", `Could not remove "${itemName}".`);
                    }
                } // End onPress
            }
        ]);
    }, [
        deleteMediaFromDB, currentMedia?.id, handleStopPlayback, setLibrary, playlists,
        favoriteIds, saveFavoritesToStorage, savePlaylists, updatePlaylist, loadPlaylists, dbInitialized // Added dependencies
    ]);

    // --- Toggle Favorite (Handles Both Platforms) ---
    const handleToggleFavorite = useCallback(async (id, makeFavorite) => {
        if (id == null) return;
        console.log(`Toggling favorite status for ID ${id} to ${makeFavorite}`);

        if (Platform.OS === 'web') {
            // Web: Update the item in IndexedDB
            const success = await updateMediaInDB(id, { isFavorite: makeFavorite }); // updateMediaInDB handles DB and state update
            if (success) {
                console.log(`Favorite status updated successfully for ID ${id} in DB.`);
            } else {
                console.error(`Failed to update favorite status for ID ${id} in DB.`);
                Alert.alert("Error", "Could not update favorite status.");
            }
        } else {
            // Native: Update favoriteIds Set, save to AsyncStorage, and update library/currentMedia state
            const newFavs = new Set(favoriteIds);
            let changed = false;
            if (makeFavorite) {
                if (!newFavs.has(id)) {
                    newFavs.add(id);
                    changed = true;
                }
            } else {
                if (newFavs.has(id)) {
                    newFavs.delete(id);
                    changed = true;
                }
            }

            // Only proceed if the status actually changed
            if (changed) {
                setFavoriteIds(newFavs); // Update the Set in state
                await saveFavoritesToStorage(newFavs); // Persist the change

                // Update the item in the library state directly
                setLibrary(prevLibrary => prevLibrary.map(item =>
                    item.id === id ? { ...item, isFavorite: makeFavorite } : item
                ));
                 // If the updated item is the current media, update that too
                 if (currentMedia?.id === id) {
                    setCurrentMedia(prev => prev ? { ...prev, isFavorite: makeFavorite } : null);
                 }
                console.log(`Favorite status updated successfully for ID ${id} (Native).`);
            } else {
                 console.log(`Favorite status for ID ${id} was already ${makeFavorite}. No change needed.`);
            }
        }
    }, [dbInitialized, updateMediaInDB, favoriteIds, saveFavoritesToStorage, setLibrary, currentMedia?.id]); // Dependencies

    // --- Refresh Data ---
    const handleRefreshData = useCallback(async (currentSort = (Platform.OS === 'web' ? 'addedDate DESC' : 'name ASC')) => {
        console.log("Refreshing data...");
        setIsRefreshing(true); // Show pull-to-refresh indicator

        try {
            if (Platform.OS === 'web') {
                // Ensure DB is ready before refreshing
                if (!dbInitialized) await initDB();
                if (dbInitialized) {
                    await fetchSpotifyToken(); // Refresh token if needed
                    await loadLibraryFromDB(currentSort); // Reload library from DB
                    await loadPlaylists(); // Reload playlists from DB
                    // Optionally trigger background fetch immediately after refresh
                    fetchMissingMetadataInBackground();
                } else {
                     Alert.alert("Error", "Database not initialized. Cannot refresh.");
                }
            } else {
                // Native: Rescan and reload persistent data
                await loadFavoritesFromStorage(); // Reload favs first
                await loadPlaylists(); // Reload playlists
                await scanNativeMedia(); // Rescan media (applies favorite status)
            }
            console.log("Refresh complete.");
        } catch (error) {
            console.error("Error during data refresh:", error);
            Alert.alert("Refresh Error", `Could not refresh data: ${error.message}`);
        } finally {
            setIsRefreshing(false); // Hide indicator
        }
    }, [dbInitialized, initDB, loadLibraryFromDB, fetchSpotifyToken, fetchMissingMetadataInBackground, scanNativeMedia, loadFavoritesFromStorage, loadPlaylists]); // Dependencies

    // --- Web Audio Player Element & EQ Setup ---
    const WebAudioPlayer = useMemo(() => {
        if (Platform.OS !== 'web') return null; // Render nothing on native

        const audioElementId = 'web-audio-player-element'; // Consistent ID

        // Effect to initialize AudioContext and nodes (runs once)
        useEffect(() => {
             if (!audioContextRef.current) { // Only initialize if not already done
                 try {
                     console.log("Initializing Web Audio API Context and Nodes...");
                     // Create AudioContext
                     const context = new (window.AudioContext || window.webkitAudioContext)();
                     audioContextRef.current = context;

                     // Create Master Gain Node
                     const gain = context.createGain();
                     gain.gain.setValueAtTime(volume, context.currentTime); // Set initial volume
                     gainNodeRef.current = gain;

                     // Create EQ Filter Nodes
                     const eqNodes = EQ_BANDS.map((band, index) => {
                         const filter = context.createBiquadFilter();
                         filter.type = band.type;
                         filter.frequency.setValueAtTime(band.freq, context.currentTime);
                         filter.Q.setValueAtTime(band.Q, context.currentTime);
                         // Set initial gain from state (or 0 if state not ready)
                         filter.gain.setValueAtTime(eqGains[index] ?? 0, context.currentTime);
                         return filter;
                     });
                     eqNodesRef.current = eqNodes;

                     // Connect nodes: Source -> EQ (if any) -> Gain -> Destination
                     let sourceOutputNode = gain; // Default to gain if no EQ
                     if (eqNodes.length > 0) {
                         // Chain EQ nodes together
                         for (let i = 0; i < eqNodes.length - 1; i++) {
                             eqNodes[i].connect(eqNodes[i + 1]);
                         }
                         // Connect last EQ node to Gain node
                         eqNodes[eqNodes.length - 1].connect(gain);
                         // The source will connect to the *first* EQ node
                         sourceOutputNode = eqNodes[0];
                     }
                     // Connect Gain node to the output destination (speakers)
                     gain.connect(context.destination);

                     console.log("Web Audio graph initialized.");

                     // Add the <audio> element to the DOM if it doesn't exist
                     let audioElement = document.getElementById(audioElementId);
                     if (!audioElement) {
                         console.log("Creating hidden <audio> element...");
                         audioElement = document.createElement('audio');
                         audioElement.id = audioElementId;
                         audioElement.style.display = 'none'; // Keep it hidden
                         audioElement.preload = "metadata"; // Preload metadata only
                         audioElement.crossOrigin = "anonymous"; // Needed for some sources?
                         document.body.appendChild(audioElement);
                         webAudioElementRef.current = audioElement; // Store ref
                     }

                 } catch (e) {
                     console.error("Web Audio API setup failed:", e);
                     Alert.alert("Audio Error", "Web Audio API not supported or failed to initialize.");
                 }
             }
             // No cleanup needed here as context/nodes persist for app lifetime
        }, []); // Empty dependency array: Run only once on mount

        // Effect to manage audio element source and state based on currentMedia
        useEffect(() => {
            if (Platform.OS !== 'web' || !audioContextRef.current || !webAudioElementRef.current) return;

            const audioElement = webAudioElementRef.current;
            const context = audioContextRef.current;
            const gain = gainNodeRef.current;
            const eqNodes = eqNodesRef.current;

            // Check if we have a playable media item with a URI
            if (currentMedia && (currentMedia.type === 'audio' || currentMedia.type === 'video') && currentMedia.uri) {
                console.log("WebAudioPlayer Effect: Updating source/state for", currentMedia.name);
                // Ensure AudioContext is running (browsers might suspend it)
                if (context.state === 'suspended') {
                    context.resume().catch(e => console.warn("Failed to resume AudioContext:", e));
                }

                // Create MediaElementSourceNode if it doesn't exist or URI changed
                // It's generally safer to recreate the source node when the src changes.
                if (audioSourceNodeRef.current) {
                    try { audioSourceNodeRef.current.disconnect(); } catch(e) {} // Disconnect old source
                }
                try {
                    audioSourceNodeRef.current = context.createMediaElementSource(audioElement);
                    // Connect source to the first EQ node or Gain node
                    const firstNode = eqNodes.length > 0 ? eqNodes[0] : gain;
                    if (firstNode) {
                        audioSourceNodeRef.current.connect(firstNode);
                        console.log("Web audio source node connected.");
                    } else {
                         console.error("Could not connect source node: No EQ or Gain node found.");
                    }
                } catch (error) {
                    console.error("Error creating/connecting MediaElementSourceNode:", error);
                    // Handle error appropriately, maybe stop playback
                    handleStopPlayback(true);
                    return; // Exit effect
                }


                // Update audio element properties
                if (audioElement.src !== currentMedia.uri) {
                    console.log("Setting audioElement src:", currentMedia.uri);
                    audioElement.src = currentMedia.uri;
                    audioElement.load(); // Important: Call load() after changing src
                }
                audioElement.playbackRate = rate;
                audioElement.loop = isLooping;
                // Volume is controlled by the GainNode, not the element directly
                // audioElement.volume = volume; // Don't set element volume

            } else {
                // No playable media, ensure element is stopped and source disconnected
                console.log("WebAudioPlayer Effect: No playable media, clearing source.");
                if (audioElement.src) {
                    audioElement.pause();
                    audioElement.removeAttribute('src');
                    audioElement.load();
                }
                if (audioSourceNodeRef.current) {
                    try { audioSourceNodeRef.current.disconnect(); } catch(e) {}
                    audioSourceNodeRef.current = null;
                }
            }
        }, [currentMedia?.uri, currentMedia?.type, rate, isLooping]); // Dependencies: media URI/type, rate, loop

         // Effect to add/remove event listeners for the audio element
         useEffect(() => {
             if (Platform.OS !== 'web' || !webAudioElementRef.current) return;

             const audioElement = webAudioElementRef.current;
             console.log("Adding event listeners to web audio element.");

             // Define event handlers using onPlaybackStatusUpdate
             const handleMetadata = () => {
                 console.log("WebAudio Event: loadedmetadata");
                 const d = audioElement.duration && Number.isFinite(audioElement.duration) ? audioElement.duration * 1000 : currentMedia?.durationMillis || 0;
                 onPlaybackStatusUpdate({ isLoaded: true, isPlaying: !audioElement.paused, isBuffering: false, durationMillis: d, positionMillis: audioElement.currentTime * 1000, rate: audioElement.playbackRate, volume: gainNodeRef.current?.gain.value ?? volume, isLooping: audioElement.loop });
             };
             const handleTimeUpdate = () => {
                 // console.log("WebAudio Event: timeupdate"); // Can be very noisy
                 onPlaybackStatusUpdate({ isLoaded: true, isPlaying: !audioElement.paused, isBuffering: false, durationMillis: audioElement.duration && Number.isFinite(audioElement.duration) ? audioElement.duration * 1000 : playbackStatus?.durationMillis || 0, positionMillis: audioElement.currentTime * 1000, rate: audioElement.playbackRate, volume: gainNodeRef.current?.gain.value ?? volume, isLooping: audioElement.loop });
             };
             const handleEnded = () => {
                 console.log("WebAudio Event: ended");
                 onPlaybackStatusUpdate({ isLoaded: true, isPlaying: false, isBuffering: false, durationMillis: audioElement.duration && Number.isFinite(audioElement.duration) ? audioElement.duration * 1000 : playbackStatus?.durationMillis || 0, positionMillis: audioElement.duration * 1000, rate: audioElement.playbackRate, volume: gainNodeRef.current?.gain.value ?? volume, isLooping: audioElement.loop, didJustFinish: true });
             };
             const handleError = (e) => {
                 console.error("WebAudio Event: error", e, audioElement.error);
                 let message = "Playback error occurred.";
                 if(audioElement.error) {
                     switch (audioElement.error.code) {
                         case MediaError.MEDIA_ERR_ABORTED: message = 'Playback aborted.'; break;
                         case MediaError.MEDIA_ERR_NETWORK: message = 'Network error during playback.'; break;
                         case MediaError.MEDIA_ERR_DECODE: message = 'Error decoding media.'; break;
                         case MediaError.MEDIA_ERR_SRC_NOT_SUPPORTED: message = 'Media format not supported.'; break;
                         default: message = `Unknown playback error (Code: ${audioElement.error.code})`;
                     }
                 }
                 onPlaybackStatusUpdate({ isLoaded: false, error: message });
             };
             const handlePlay = () => {
                 console.log("WebAudio Event: play");
                 // Ensure context is running when play starts
                 if (audioContextRef.current && audioContextRef.current.state === 'suspended') {
                     audioContextRef.current.resume().catch(e => {});
                 }
                 onPlaybackStatusUpdate({ isLoaded: true, isPlaying: true, isBuffering: false, durationMillis: audioElement.duration && Number.isFinite(audioElement.duration) ? audioElement.duration * 1000 : playbackStatus?.durationMillis || 0, positionMillis: audioElement.currentTime * 1000, rate: audioElement.playbackRate, volume: gainNodeRef.current?.gain.value ?? volume, isLooping: audioElement.loop });
             };
             const handlePlaying = () => {
                 console.log("WebAudio Event: playing");
                 onPlaybackStatusUpdate({ isLoaded: true, isPlaying: true, isBuffering: false, durationMillis: audioElement.duration && Number.isFinite(audioElement.duration) ? audioElement.duration * 1000 : playbackStatus?.durationMillis || 0, positionMillis: audioElement.currentTime * 1000, rate: audioElement.playbackRate, volume: gainNodeRef.current?.gain.value ?? volume, isLooping: audioElement.loop });
             };
             const handlePause = () => {
                 console.log("WebAudio Event: pause");
                 onPlaybackStatusUpdate({ isLoaded: true, isPlaying: false, isBuffering: false, durationMillis: audioElement.duration && Number.isFinite(audioElement.duration) ? audioElement.duration * 1000 : playbackStatus?.durationMillis || 0, positionMillis: audioElement.currentTime * 1000, rate: audioElement.playbackRate, volume: gainNodeRef.current?.gain.value ?? volume, isLooping: audioElement.loop });
             };
             const handleWaiting = () => { // Buffering started
                 console.log("WebAudio Event: waiting (Buffering)");
                 onPlaybackStatusUpdate({ isLoaded: true, isPlaying: !audioElement.paused, isBuffering: true, durationMillis: audioElement.duration && Number.isFinite(audioElement.duration) ? audioElement.duration * 1000 : playbackStatus?.durationMillis || 0, positionMillis: audioElement.currentTime * 1000, rate: audioElement.playbackRate, volume: gainNodeRef.current?.gain.value ?? volume, isLooping: audioElement.loop });
             };
             const handleCanPlay = () => { // Enough data loaded to play (or resume after buffering)
                 console.log("WebAudio Event: canplay");
                 // If we were buffering, mark buffering as false
                 if (playbackStatus?.isBuffering) {
                     onPlaybackStatusUpdate({ isLoaded: true, isPlaying: !audioElement.paused, isBuffering: false, durationMillis: audioElement.duration && Number.isFinite(audioElement.duration) ? audioElement.duration * 1000 : playbackStatus?.durationMillis || 0, positionMillis: audioElement.currentTime * 1000, rate: audioElement.playbackRate, volume: gainNodeRef.current?.gain.value ?? volume, isLooping: audioElement.loop });
                 }
                 // Auto-play if needed (e.g., after initial load triggered by loadAndPlayMedia)
                 // This might be handled by the loadAndPlayMedia function already.
             };

             // Add listeners
             audioElement.addEventListener('loadedmetadata', handleMetadata);
             audioElement.addEventListener('timeupdate', handleTimeUpdate);
             audioElement.addEventListener('ended', handleEnded);
             audioElement.addEventListener('error', handleError);
             audioElement.addEventListener('play', handlePlay);
             audioElement.addEventListener('playing', handlePlaying);
             audioElement.addEventListener('pause', handlePause);
             audioElement.addEventListener('waiting', handleWaiting);
             audioElement.addEventListener('canplay', handleCanPlay); // Fired when buffering ends or ready to play

             // Cleanup: Remove listeners on unmount or dependency change
             return () => {
                 console.log("Removing event listeners from web audio element.");
                 audioElement.removeEventListener('loadedmetadata', handleMetadata);
                 audioElement.removeEventListener('timeupdate', handleTimeUpdate);
                 audioElement.removeEventListener('ended', handleEnded);
                 audioElement.removeEventListener('error', handleError);
                 audioElement.removeEventListener('play', handlePlay);
                 audioElement.removeEventListener('playing', handlePlaying);
                 audioElement.removeEventListener('pause', handlePause);
                 audioElement.removeEventListener('waiting', handleWaiting);
                 audioElement.removeEventListener('canplay', handleCanPlay);
             };
             // Dependencies: Callback function, volume (for status updates), and potentially other state used in handlers
         }, [onPlaybackStatusUpdate, volume, playbackStatus?.durationMillis, playbackStatus?.isBuffering]); // Added relevant dependencies

        // The component itself renders nothing visible
        return null; // Or return the <audio> element directly if preferred, but managing via ref is cleaner

    }, [Platform.OS, onPlaybackStatusUpdate, volume, rate, isLooping, eqGains, currentMedia?.id, playbackStatus?.durationMillis, playbackStatus?.isBuffering, currentMedia?.uri, currentMedia?.type]); // Dependencies for the useMemo


    // --- Settings Screen - Clear Web DB Function ---
    const handleClearWebDB = useCallback(() => {
        if (Platform.OS !== 'web') return;

        Alert.alert(
            "Confirm Clear Database",
            "This will permanently delete your entire IndexedDB library and all playlists stored in this browser. This action cannot be undone. Are you sure?",
            [
                { text: "Cancel", style: "cancel" },
                {
                    text: "Clear Database",
                    style: "destructive",
                    onPress: async () => {
                        console.log("Attempting to clear IndexedDB...");
                        setIsDbLoading(true); // Show loading indicator
                        try {
                            // 1. Stop any current playback
                            await handleStopPlayback(true);

                            // 2. Close the existing DB connection if open
                            if (dbPromise) {
                                const db = await dbInstancePromise;
                                db.close(); // Close the connection
                                dbPromise = null; // Reset the promise
                                setDbInitialized(false); // Mark DB as not initialized
                                console.log("IndexedDB connection closed.");
                            }

                            // 3. Delete the database
                            await new Promise((resolve, reject) => {
                                console.log(`Requesting deletion of database: ${DB_NAME}`);
                                const deleteRequest = indexedDB.deleteDatabase(DB_NAME);
                                deleteRequest.onsuccess = () => {
                                    console.log(`Database ${DB_NAME} deleted successfully.`);
                                    resolve();
                                };
                                deleteRequest.onerror = (event) => {
                                    console.error(`Error deleting database ${DB_NAME}:`, event.target.error);
                                    reject(new Error(`Failed to delete database: ${event.target.error}`));
                                };
                                deleteRequest.onblocked = (event) => {
                                    // This happens if the DB is still open in another tab/window
                                    console.warn(`Database ${DB_NAME} deletion blocked. Close other tabs/windows using the app.`);
                                    reject(new Error("Database deletion blocked. Please close other tabs running this app and try again."));
                                };
                            });

                            // 4. Clear relevant application state
                            setLibrary([]);
                            setPlaylists([]);
                            setCurrentMedia(null);
                            setPlaybackStatus(null);
                            setIsPlayerFullScreen(false);
                            setPlaybackQueue([]);
                            setCurrentQueueIndex(-1);
                            // Keep API tokens etc.

                            // 5. Inform user and suggest reload
                            Alert.alert(
                                "Success",
                                "Web library and playlists cleared successfully. Please reload the application for changes to take full effect.",
                                [{ text: "Reload Now", onPress: () => window.location.reload() }, { text: "Later" }]
                            );

                        } catch (err) {
                            console.error("Failed to clear IndexedDB:", err);
                            Alert.alert("Error", `Could not clear web library: ${err.message}`);
                            // Attempt to reopen the database connection after a failed deletion attempt
                            dbInstancePromise = openDatabase();
                            initDB(); // Try to re-initialize
                        } finally {
                            setIsDbLoading(false); // Hide loading indicator
                        }
                    } // End onPress
                }
            ]
        );
    }, [handleStopPlayback, initDB]); // Dependencies

    // --- Show Add to Playlist Modal ---
    const handleShowAddToPlaylist = useCallback((trackId) => {
        if (trackId == null) return;
        // Check if there are playlists to add to
        if (!playlists || playlists.length === 0) {
             Alert.alert("No Playlists", "Create a playlist first in the Playlists tab before adding tracks.");
             return;
        }
        setTrackIdToAddToPlaylist(trackId); // Store the track ID
        setShowAddToPlaylistModal(true); // Show the modal
    }, [playlists]); // Dependency: playlists

    // --- Screen Components for Tabs (Memoized) ---
    // Use useIsFocused hook within a wrapper component for screens needing focus state
    const FocusedLibraryScreen = useCallback((props) => {
        const isFocused = useIsFocused();
        return <LibraryScreen {...props} isFocused={isFocused} />;
    }, []); // No dependencies needed for the wrapper itself

    // Memoize common props passed to library screens
    const commonLibraryProps = useMemo(() => ({
        library: library,
        playlists: playlists, // Pass playlists for Add To Playlist feature
        dbInitialized: dbInitialized,
        isDbLoading: isDbLoading,
        isRefreshing: isRefreshing,
        fetchingMetadataIds: fetchingMetadataIds,
        currentMedia: currentMedia,
        playbackStatus: playbackStatus,
        onLoadAndPlay: loadAndPlayMedia,
        onRefreshData: handleRefreshData,
        onToggleFavorite: handleToggleFavorite,
        onDeleteMedia: handleDeleteMedia,
        onDownloadMedia: downloadBlobUri, // Web only download
        onRequestMetadataFetch: searchSpotifyAndFetchMetadata, // Web only metadata fetch
        onViewParamsChange: setCurrentViewParams, // Callback to update App state
        onShowAddToPlaylist: handleShowAddToPlaylist, // Pass modal handler
    }), [
        library, playlists, dbInitialized, isDbLoading, isRefreshing, fetchingMetadataIds,
        currentMedia, playbackStatus, loadAndPlayMedia, handleRefreshData,
        handleToggleFavorite, handleDeleteMedia, searchSpotifyAndFetchMetadata,
        setCurrentViewParams, handleShowAddToPlaylist
    ]);

    // Define Tab Screens using useCallback for stability if props don't change
    const FilesScreen = useCallback(() => <FocusedLibraryScreen {...commonLibraryProps} filterType="all" onPickFiles={pickFiles} />, [commonLibraryProps, pickFiles, FocusedLibraryScreen]);
    const MusicScreen = useCallback(() => <FocusedLibraryScreen {...commonLibraryProps} filterType="audio" />, [commonLibraryProps, FocusedLibraryScreen]);
    const VideoScreen = useCallback(() => <FocusedLibraryScreen {...commonLibraryProps} filterType="video" />, [commonLibraryProps, FocusedLibraryScreen]);
    const ImageScreen = useCallback(() => <FocusedLibraryScreen {...commonLibraryProps} filterType="image" />, [commonLibraryProps, FocusedLibraryScreen]);
    const FavoritesScreen = useCallback(() => <FocusedLibraryScreen {...commonLibraryProps} filterType="favorites" />, [commonLibraryProps, FocusedLibraryScreen]);

    // Playlist Stack Wrapper (Memoized)
    const PlaylistStackWrapper = useCallback(() => (
        <PlaylistStackScreen
            // Props needed by the stack navigator and its screens
            library={library} // Needed for PlaylistDetailScreen
            currentMedia={currentMedia} // Needed for PlaylistDetailScreen
            playbackStatus={playbackStatus} // Needed for PlaylistDetailScreen
            playlists={playlists} // Needed for PlaylistsScreen & navigation
            onLoadAndPlay={loadAndPlayMedia} // Needed for PlaylistDetailScreen
            onRemoveFromPlaylist={handleRemoveFromPlaylist} // Needed for PlaylistDetailScreen
            onCreatePlaylist={addPlaylist} // Needed for PlaylistsScreen
            onDeletePlaylist={deletePlaylist} // Needed for PlaylistsScreen
            onRenamePlaylist={updatePlaylist} // Needed for PlaylistsScreen (uses updatePlaylist)
        />
    ), [library, currentMedia, playbackStatus, playlists, loadAndPlayMedia, handleRemoveFromPlaylist, addPlaylist, deletePlaylist, updatePlaylist]); // Dependencies

    // Settings Screen Wrapper (Memoized)
    const SettingsScreenComponent = useCallback(() => (
        <SettingsScreen
            onScanDeviceMedia={scanNativeMedia} // Native only scan
            onClearWebDB={handleClearWebDB} // Web only clear DB
            isScanningNative={isScanningNative} // Pass scanning state
            onPickDocument={handlePickDocument} // Pass native file picker handler
        />
     ), [scanNativeMedia, handleClearWebDB, isScanningNative, handlePickDocument]); // Dependencies


    // --- Main Return Structure ---
    return (
        // Use SafeAreaView at the top level for status bar and notches
        <SafeAreaView style={styles.appSafeArea}>
            <NavigationContainer>
                <Tab.Navigator
                    screenOptions={({ route }) => ({
                        headerShown: false, // Hide default header for tab screens
                        tabBarIcon: ({ focused, color, size }) => {
                            let iconName;
                            // Determine icon based on route name and focus state
                            switch (route.name) {
                                case 'Files': iconName = focused ? 'folder' : 'folder-outline'; break;
                                case 'Music': iconName = focused ? 'musical-notes' : 'musical-notes-outline'; break;
                                case 'Videos': iconName = focused ? 'videocam' : 'videocam-outline'; break;
                                case 'Images': iconName = focused ? 'image' : 'image-outline'; break;
                                case 'Playlists': iconName = focused ? 'list' : 'list-outline'; break;
                                case 'Favorites': iconName = focused ? 'heart' : 'heart-outline'; break;
                                case 'Settings': iconName = focused ? 'settings' : 'settings-outline'; break;
                                default: iconName = 'help-circle-outline'; // Fallback icon
                            }
                            return <Ionicons name={iconName} size={size * 0.9} color={color} />;
                        },
                        tabBarActiveTintColor: '#1DB954', // Color for active tab
                        tabBarInactiveTintColor: '#888', // Color for inactive tabs
                        tabBarStyle: { // Style the tab bar itself
                            backgroundColor: '#121212', // Dark background
                            borderTopColor: '#282828', // Subtle top border
                            borderTopWidth: 1,
                            height: TAB_BAR_HEIGHT, // Consistent height
                            paddingBottom: Platform.OS === 'ios' ? 0 : 5, // Adjust padding for OS differences
                            paddingTop: 5,
                        },
                        tabBarLabelStyle: { // Style the text label under the icon
                            fontSize: 10,
                            marginBottom: 3,
                        },
                    })}
                >
                    {/* Define Tab Screens */}
                    <Tab.Screen name="Files" component={FilesScreen} />
                    <Tab.Screen name="Music" component={MusicScreen} />
                    <Tab.Screen name="Videos" component={VideoScreen} />
                    <Tab.Screen name="Images" component={ImageScreen} />
                    <Tab.Screen name="Playlists" component={PlaylistStackWrapper} /> {/* Use the Stack Navigator here */}
                    <Tab.Screen name="Favorites" component={FavoritesScreen} />
                    <Tab.Screen name="Settings" component={SettingsScreenComponent} />
                </Tab.Navigator>
            </NavigationContainer>

            {/* Render the hidden Web Audio Player element (Web only) */}
            {Platform.OS === 'web' && WebAudioPlayer}

            {/* Mini Player Bar (Absolutely positioned above the tab bar) */}
            <View style={styles.miniPlayerWrapper}>
                <MiniPlayerBar
                    currentMedia={currentMedia}
                    playbackStatus={playbackStatus}
                    // Show loading specifically when changing audio/video tracks
                    isLoading={isLoading && currentMedia != null && (currentMedia.type === 'audio' || currentMedia.type === 'video')}
                    onPlayPause={handlePlayPause}
                    // Expand only for playable types
                    onExpandPlayer={() => { if (currentMedia?.type === 'audio' || currentMedia?.type === 'video') setIsPlayerFullScreen(true); }}
                />
            </View>

            {/* Full Screen Player Modal */}
            <FullScreenPlayer
                // Show only if player should be full screen and media is playable
                isVisible={isPlayerFullScreen && (currentMedia?.type === 'audio' || currentMedia?.type === 'video')}
                media={currentMedia}
                playbackStatus={playbackStatus}
                // Show loading indicator in full screen player as well
                isLoading={isLoading && currentMedia != null}
                isFetchingLyrics={isFetchingLyrics}
                lyrics={currentLyricsChords}
                volume={volume} rate={rate} isLooping={isLooping} eqGains={eqGains}
                // Determine if next/previous tracks exist in the current queue
                hasNext={currentQueueIndex !== -1 && currentQueueIndex < playbackQueue.length - 1}
                hasPrevious={currentQueueIndex > 0}
                onClose={() => setIsPlayerFullScreen(false)}
                onPlayPause={handlePlayPause} onSeek={handleSeek}
                onShowLyrics={() => {
                    // Logic to show/fetch lyrics
                    if (currentMedia && Platform.OS === 'web' && genAI) {
                        fetchLyricsAndChordsFromGemini(currentMedia); // Fetch if needed
                    } else if (currentMedia?.lyricsChords) {
                        // If lyrics already exist in media data (e.g., from DB)
                        setCurrentLyricsChords(currentMedia.lyricsChords);
                        setShowLyricsModal(true);
                    } else if (Platform.OS !== 'web' || !genAI) {
                        Alert.alert("Unavailable", "Lyrics fetching requires Gemini API on the web platform.");
                    }
                }}
                onVolumeChange={handleVolumeChange} onRateChange={handleRateChange} onLoopToggle={handleLoopToggle}
                onNextTrack={handleNextTrack} onPreviousTrack={handlePreviousTrack}
                onEqGainChange={handleEqGainChange} onResetEq={handleResetEq}
            />

            {/* Lyrics Viewer Modal */}
            <LyricsViewer
                isVisible={showLyricsModal}
                isLoading={isFetchingLyrics}
                lyrics={currentLyricsChords}
                trackName={currentMedia?.trackName || currentMedia?.name}
                onClose={() => setShowLyricsModal(false)}
                // Provide fetch function only if applicable
                onFetch={(currentMedia && !currentLyricsChords && !isFetchingLyrics && Platform.OS === 'web' && genAI) ? () => fetchLyricsAndChordsFromGemini(currentMedia) : undefined}
            />

            {/* Image Viewer Modal */}
            <ImageViewerModal
                isVisible={showImageViewer}
                images={imageViewerList} // List of images in current context
                initialIndex={imageViewerIndex} // Starting image index
                onClose={() => setShowImageViewer(false)}
                onIndexChanged={setImageViewerIndex} // Update index on swipe
            />

            {/* Add To Playlist Modal */}
            <AddToPlaylistModal
                isVisible={showAddToPlaylistModal}
                playlists={playlists} // Pass available playlists
                onAddToPlaylist={(playlistId) => {
                    // Add the stored track ID to the selected playlist ID
                    if (trackIdToAddToPlaylist != null) {
                        handleAddToPlaylist(trackIdToAddToPlaylist, playlistId);
                    }
                    // Close modal and clear track ID
                    setShowAddToPlaylistModal(false);
                    setTrackIdToAddToPlaylist(null);
                }}
                onClose={() => {
                    // Just close modal and clear track ID
                    setShowAddToPlaylistModal(false);
                    setTrackIdToAddToPlaylist(null);
                }}
            />

             {/* Global Loading Overlay */}
             {/* Show overlay if any relevant loading state is true */}
             {(isLoading || isScanningNative || (Platform.OS === 'web' && isDbLoading)) && (
                 <View style={styles.globalLoadingOverlay}>
                     <ActivityIndicator size="large" color="#1DB954" />
                     {/* Provide more specific loading text */}
                     <Text style={styles.loadingText}>
                         {isScanningNative ? 'Scanning Device...' :
                          (Platform.OS === 'web' && isDbLoading) ? 'Processing Files...' :
                          // More specific initial loading text for web
                          (isLoading && library.length === 0 && !isRefreshing && Platform.OS === 'web' && !dbInitialized) ? 'Initializing Database...' :
                          (isLoading && library.length === 0 && !isRefreshing && Platform.OS === 'web') ? 'Loading Library...' :
                          // General loading text
                          isLoading ? 'Loading...' :
                          'Please wait...'}
                     </Text>
                 </View>
             )}
        </SafeAreaView>
    );
}

// --- Styles --- (Includes styles for new components/modals)
const styles = StyleSheet.create({
    // --- App Level ---
    appSafeArea: { flex: 1, backgroundColor: '#000' }, // Ensure safe area background is black
    miniPlayerWrapper: {
        position: 'absolute',
        bottom: TAB_BAR_HEIGHT, // Position above the tab bar
        left: 0,
        right: 0,
        zIndex: 10, // Ensure it's above the main content
    },
    globalLoadingOverlay: {
        position: 'absolute', // Cover entire screen
        top: 0, left: 0, right: 0, bottom: 0,
        backgroundColor: 'rgba(0, 0, 0, 0.75)', // Semi-transparent black
        justifyContent: 'center',
        alignItems: 'center',
        zIndex: 1000, // Ensure it's above everything else
    },
    loadingText: {
        marginTop: 15,
        color: '#ccc',
        fontSize: 16,
        fontWeight: '500'
    },
    // --- LibraryScreen Level ---
    libraryScreenContainer: { flex: 1, backgroundColor: '#000' }, // Black background for screens
    header: {
        flexDirection: 'row',
        justifyContent: 'space-between',
        alignItems: 'center',
        paddingHorizontal: 10,
        height: 60, // Standard header height
        backgroundColor: '#121212', // Dark header background
        borderBottomWidth: 1,
        borderBottomColor: '#282828' // Subtle border
    },
    headerTitle: {
        fontSize: 20,
        fontWeight: 'bold',
        color: 'white',
        textAlign: 'center',
        flexShrink: 1, // Allow title to shrink if needed
        marginHorizontal: 10
    },
    headerIcon: {
        padding: 8, // Touch target size
        width: 42, // Fixed width for alignment
        alignItems: 'center'
    },
    searchBarContainer: { // Covers header area when active
        position: 'absolute',
        top: 0, left: 0, right: 0, bottom: 0,
        flexDirection: 'row',
        alignItems: 'center',
        backgroundColor: '#121212',
        paddingHorizontal: 5,
        zIndex: 1 // Ensure search bar is above header content
    },
    searchBarIcon: { paddingHorizontal: 8 },
    searchInput: {
        flex: 1,
        backgroundColor: '#282828', // Dark input background
        borderRadius: 8,
        color: 'white',
        paddingHorizontal: 12,
        paddingVertical: Platform.OS === 'ios' ? 10 : 8, // Platform-specific padding
        fontSize: 16,
        marginHorizontal: 5,
        height: 40 // Fixed height
    },
    container: { flex: 1, backgroundColor: '#000', position: 'relative' }, // Main content area
    listContentContainer: { paddingTop: 5, paddingBottom: 10 }, // Padding for FlatList content
    emptyContainer: { // Styles for empty list message
        flex: 1,
        justifyContent: 'center',
        alignItems: 'center',
        padding: 30,
        marginTop: height * 0.05 // Push down slightly from top
    },
    emptyText: {
        color: '#aaa',
        textAlign: 'center',
        marginTop: 20,
        fontSize: 18,
        fontWeight: 'bold'
    },
    emptySubText: {
        color: '#888',
        textAlign: 'center',
        marginTop: 10,
        fontSize: 14,
        paddingHorizontal: 20,
        lineHeight: 20
    },
    fab: { // Floating Action Button (Web only)
        position: 'absolute',
        bottom: 20, right: 20,
        backgroundColor: '#1DB954', // Spotify green
        width: 60, height: 60,
        borderRadius: 30, // Circular
        justifyContent: 'center',
        alignItems: 'center',
        elevation: 8, // Android shadow
        shadowColor: '#000', // iOS shadow
        shadowOffset: { width: 0, height: 4 },
        shadowOpacity: 0.3,
        shadowRadius: 4,
        zIndex: 5 // Above list content
    },
    separator: { // Separator line for lists
        height: StyleSheet.hairlineWidth, // Thin line
        backgroundColor: '#282828', // Dark separator color
        marginVertical: 0, // No vertical margin for tight packing
        marginHorizontal: 15 // Indent separator
    },
    // --- MediaListItem ---
    itemContainer: {
        flexDirection: 'row',
        alignItems: 'center',
        paddingVertical: 8,
        paddingHorizontal: 15,
        height: 65, // Fixed height for getItemLayout
        backgroundColor: '#000' // Match screen background
    },
    itemContainerCurrent: { backgroundColor: 'rgba(40, 40, 40, 0.7)' }, // Highlight current item
    itemThumbnail: {
        width: 45, height: 45,
        borderRadius: 4, // Slightly rounded corners
        marginRight: 15,
        backgroundColor: '#333' // Placeholder background
    },
    itemTextContainer: { flex: 1, justifyContent: 'center', marginRight: 10 },
    itemTitle: { color: 'white', fontSize: 16, fontWeight: '500' },
    itemSubtitle: { color: '#aaa', fontSize: 13, marginTop: 3 },
    itemRightContainer: { flexDirection: 'row', alignItems: 'center' },
    itemFavoriteIcon: { marginRight: 8 },
    itemDuration: { color: '#aaa', fontSize: 13, marginLeft: 10 },
    itemActivityIndicator: { marginHorizontal: 5 },
    itemPlayingIndicator: { marginLeft: 10 },
    itemTypeIcon: { marginLeft: 8 },
    // --- MiniPlayerBar ---
    playerBarContainer: {
        height: MINI_PLAYER_HEIGHT,
        backgroundColor: '#181818', // Slightly lighter dark color
        borderTopWidth: 1,
        borderTopColor: '#282828',
        // Shadow for elevation effect
        shadowColor: '#000',
        shadowOffset: { width: 0, height: -2 },
        shadowOpacity: 0.3,
        shadowRadius: 3,
        elevation: 10,
        overflow: 'hidden' // Hide progress bar overflow
    },
    playerProgressLineBackground: {
        height: 2, // Thin progress line
        backgroundColor: '#555', // Background color
        position: 'absolute',
        top: 0, left: 0, right: 0
    },
    playerProgressLineForeground: {
        height: '100%',
        backgroundColor: '#1DB954' // Progress color
    },
    playerBarContent: {
        flexDirection: 'row',
        alignItems: 'center',
        paddingHorizontal: 10,
        flex: 1,
        paddingTop: 2 // Account for progress line height
    },
    playerThumbnail: {
        width: 45, height: 45,
        borderRadius: 4,
        marginRight: 10,
        backgroundColor: '#333'
    },
    playerInfo: { flex: 1, justifyContent: 'center', marginRight: 5, overflow: 'hidden' },
    playerTitle: { color: 'white', fontSize: 14, fontWeight: 'bold' },
    playerSubtitle: { color: '#b3b3b3', fontSize: 12 },
    playerControl: { padding: 8, marginLeft: 5 }, // Play/pause button touch area
    // --- FullScreenPlayer & Modals ---
    fullPlayerContainer: {
        flex: 1,
        backgroundColor: '#0a0a0a', // Very dark background
        justifyContent: 'space-between' // Distribute elements vertically
    },
    fullPlayerHeader: {
        flexDirection: 'row',
        justifyContent: 'space-between',
        alignItems: 'center',
        paddingHorizontal: 15,
        paddingTop: Platform.OS === 'ios' ? 10 : 20, // Adjust top padding for status bar
        height: 50,
        zIndex: 1 // Keep header above video
    },
    fullPlayerCloseButton: { padding: 5, width: 40, alignItems: 'flex-start' },
    fullPlayerHeaderButton: { padding: 5, width: 50, alignItems: 'flex-end' },
    fullPlayerRateText: { color: 'white', fontSize: 14, fontWeight: 'bold' },
    fullPlayerHeaderText: { color: '#ccc', fontSize: 14, fontWeight: 'bold', flex: 1, textAlign: 'center', marginHorizontal: 5 },
    fullPlayerArtContainer: { // Area for artwork (audio)
        flex: 1, // Take up available space
        justifyContent: 'center',
        alignItems: 'center',
        paddingHorizontal: 30,
        paddingVertical: 10,
        minHeight: width * 0.7, // Ensure minimum height
        zIndex: 1
    },
    fullPlayerArtContainerPlaceholder: { // Takes up space when video is showing
        flex: 1,
        minHeight: width * 0.7,
    },
    fullPlayerArt: { // Artwork image itself
        width: width * 0.8, height: width * 0.8, // Large artwork
        borderRadius: 8,
        backgroundColor: '#333' // Placeholder background
    },
    fullPlayerVideo: { // Native video style
        position: 'absolute',
        top: 0, left: 0, bottom: 0, right: 0,
        backgroundColor: 'black', // Black background behind video
        zIndex: 0 // Behind controls
    },
    fullPlayerVideoWeb: { // Web video style
        position: 'absolute',
        top: 60, // Below header
        left: 0,
        right: 0,
        bottom: 250, // Above controls (adjust as needed)
        width: '100%',
        height: 'auto', // Adjust height automatically? Or fixed?
        backgroundColor: 'black',
        zIndex: 0,
        objectFit: 'contain', // Like ResizeMode.CONTAIN
    },
    fullPlayerInfoContainer: { alignItems: 'center', paddingHorizontal: 20, marginBottom: 10, zIndex: 1 },
    fullPlayerTitle: { color: 'white', fontSize: 22, fontWeight: 'bold', textAlign: 'center', marginBottom: 5 },
    fullPlayerArtist: { color: '#b3b3b3', fontSize: 16, textAlign: 'center' },
    fullPlayerProgressContainer: { paddingHorizontal: 25, marginBottom: 10, zIndex: 1 },
    fullPlayerSlider: { width: '100%', height: 40 }, // Slider touch area
    fullPlayerTimeContainer: { flexDirection: 'row', justifyContent: 'space-between', marginTop: -5 },
    fullPlayerTimeText: { color: '#aaa', fontSize: 12 },
    fullPlayerControlsContainer: { flexDirection: 'row', justifyContent: 'space-around', alignItems: 'center', paddingHorizontal: 20, marginBottom: 15, zIndex: 1 },
    fullPlayerPlayPauseButton: { marginHorizontal: 15 }, // Space around play/pause
    fullPlayerControlButton: { padding: 10 }, // Touch area for other controls
    fullPlayerBottomActions: {
        flexDirection: 'row',
        justifyContent: 'space-between',
        alignItems: 'center',
        paddingBottom: Platform.OS === 'ios' ? 30 : 20, // More padding at bottom for safe area/home indicator
        paddingHorizontal: 20,
        zIndex: 1
    },
    fullPlayerActionButton: { alignItems: 'center', minWidth: 60, paddingVertical: 5, flex: 1, justifyContent: 'center' },
    fullPlayerActionButtonPlaceholder: { flex: 1, minWidth: 60 }, // Takes up space if button not shown
    fullPlayerActionButtonText: { color: 'white', fontSize: 10, marginTop: 4 },
    volumeControlContainer: { flexDirection: 'row', alignItems: 'center', flex: 3, marginHorizontal: 10 }, // Volume slider takes more space
    volumeSlider: { flex: 1, height: 30 },
    modalContainer: { // For Lyrics, AddToPlaylist, CreatePlaylist modals
        flex: 1,
        justifyContent: 'flex-end', // Position modal at the bottom
        backgroundColor: 'rgba(0, 0, 0, 0.7)' // Dim background
    },
    modalContent: { // Content area of the modal
        backgroundColor: '#181818', // Dark background for modal content
        borderTopLeftRadius: 15,
        borderTopRightRadius: 15,
        padding: 15,
        paddingTop: 10,
        maxHeight: '90%', // Limit modal height
        // Shadow for modal elevation
        shadowColor: '#000',
        shadowOffset: { width: 0, height: -3 },
        shadowOpacity: 0.3,
        shadowRadius: 5,
        elevation: 10
    },
    modalHeader: {
        flexDirection: 'row',
        justifyContent: 'space-between',
        alignItems: 'center',
        borderBottomWidth: 1,
        borderBottomColor: '#333', // Separator line
        paddingBottom: 10,
        marginBottom: 10
    },
    modalTitle: { fontSize: 18, fontWeight: 'bold', color: 'white', flex: 1, marginRight: 10 },
    lyricsScrollView: { marginBottom: 10, flexShrink: 1 }, // Allow scroll view to shrink
    lyricsScrollContent: { paddingBottom: 20 }, // Padding at the bottom of lyrics
    lyricsText: {
        fontSize: Platform.OS === 'ios' ? 17 : 16, // Slightly larger font for lyrics
        color: '#e0e0e0', // Light gray color
        lineHeight: 28, // Generous line height
        fontFamily: Platform.OS === 'ios' ? 'Menlo' : 'monospace', // Monospace font
        whiteSpace: 'pre-wrap' // Preserve whitespace and wrap lines (Web)
    },
    loadingOverlayModal: { // Loading indicator inside modal
        justifyContent: 'center',
        alignItems: 'center',
        padding: 20,
        minHeight: 200
    },
    modalButtonContainer: { // Spacing for buttons inside modal
        marginTop: 10,
        marginBottom: Platform.OS === 'ios' ? 15 : 5 // Extra bottom margin for iOS home indicator area
    },
    // --- ImageViewerModal ---
    imageViewerSafeArea: { flex: 1, backgroundColor: 'black' }, // Black background for image viewer
    imageViewerHeader: { // Header shown above the image
        position: 'absolute',
        top: 0, left: 0, right: 0,
        flexDirection: 'row',
        justifyContent: 'space-between',
        alignItems: 'center',
        paddingHorizontal: 10,
        paddingTop: Platform.OS === 'ios' ? 50 : 30, // Account for status bar
        paddingBottom: 10,
        backgroundColor: 'rgba(0,0,0,0.5)', // Semi-transparent background
        zIndex: 2 // Above image
    },
    imageViewerTitle: { color: 'white', fontSize: 16, fontWeight: 'bold', textAlign: 'center', flex: 1, marginHorizontal: 10 },
    imageViewerButton: { padding: 10 }, // Touch area for header buttons
    imageViewerIndicator: { // Page indicator (e.g., "2 / 5")
        position: 'absolute',
        bottom: 20,
        alignSelf: 'center',
        backgroundColor: 'rgba(0,0,0,0.5)',
        borderRadius: 10,
        paddingHorizontal: 10,
        paddingVertical: 5,
        zIndex: 2 // Above image
    },
    imageViewerIndicatorText: { color: 'white', fontSize: 14 },
    // --- Placeholder & Settings Screens ---
    placeholderSafeArea: { flex: 1, backgroundColor: '#000' }, // Use safe area for settings
    settingsScrollContainer: { // Content container for ScrollView
        padding: 20,
        paddingBottom: 40, // Extra padding at the bottom
        alignItems: 'center', // Center items horizontally
    },
    settingsIconContainer: { alignItems: 'center', marginBottom: 20, marginTop: 20, },
    placeholderContainer: { flex: 1, justifyContent: 'flex-start', alignItems: 'center', padding: 20, paddingTop: 40 },
    placeholderText: { fontSize: 20, color: '#aaa', marginBottom: 10 },
    placeholderSubText: { fontSize: 14, color: '#888', textAlign: 'center' },
    settingItem: { // Container for each setting
        marginVertical: 15,
        width: '95%', // Take most of the width
        alignItems: 'center',
        paddingVertical: 10,
        borderBottomWidth: StyleSheet.hairlineWidth, // Subtle separator
        borderBottomColor: '#282828',
    },
    settingTitle: { fontSize: 16, color: '#ccc', fontWeight: 'bold', marginBottom: 8, },
    settingDescription: { fontSize: 12, color: '#888', textAlign: 'center', marginTop: 8, paddingHorizontal: 10, lineHeight: 18, },
    // --- EQ Styles ---
    eqContainer: { // Container for the EQ section in FullScreenPlayer
        backgroundColor: '#202020', // Slightly different dark background
        paddingHorizontal: 15,
        paddingTop: 10,
        paddingBottom: Platform.OS === 'ios' ? 25 : 15, // Extra padding for iOS home indicator
        borderTopWidth: 1,
        borderTopColor: '#404040', // Separator line
        minHeight: 180, // Ensure enough height for sliders
        zIndex: 5, // Keep EQ above video/artwork if overlapping
    },
    eqHeader: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', marginBottom: 5, },
    eqTitle: { color: 'white', fontSize: 16, fontWeight: 'bold', },
    eqNote: { color: '#aaa', fontSize: 11, textAlign: 'center', marginBottom: 10, fontStyle: 'italic', },
    eqSlidersContainer: { // Holds the vertical sliders
        flexDirection: 'row',
        justifyContent: 'space-around',
        alignItems: 'flex-end', // Align sliders at the bottom
        height: 130, // Fixed height for slider area
    },
    eqSliderWrapper: { // Wrapper for each slider + labels
        alignItems: 'center',
        height: '100%',
        justifyContent: 'flex-end', // Align content (label, slider, label) to bottom
        marginHorizontal: 3,
        flex: 1 // Distribute space evenly
    },
    eqBandLabel: { color: '#ccc', fontSize: 10, marginBottom: 5, },
    eqSlider: { // Style for the vertical slider
        width: 90, // Width becomes height due to rotation
        height: 40, // Height becomes width
        transform: [{ rotate: '-90deg' }], // Rotate slider vertically
        marginBottom: 25, // Space below rotated slider
        marginTop: 25, // Space above rotated slider
    },
    eqGainLabel: { color: '#ccc', fontSize: 10, marginTop: 5, },
    // --- Playlist Styles ---
    playlistIcon: { // Icon specific to playlist list items
        width: 45, height: 45, // Match thumbnail size
        textAlign: 'center',
        lineHeight: 45, // Center icon vertically
        marginRight: 15
    },
    playlistModalItem: { // Style for items in AddToPlaylist modal
        flexDirection: 'row',
        alignItems: 'center',
        paddingVertical: 12,
        paddingHorizontal: 10
    },
    playlistModalItemText: { color: 'white', fontSize: 16, flex: 1 },
    playlistInput: { // Style for create playlist name input
        backgroundColor: '#282828',
        borderRadius: 8,
        color: 'white',
        paddingHorizontal: 15,
        paddingVertical: 12,
        fontSize: 16,
        marginVertical: 15, // Space around input
    },
});
