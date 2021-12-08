import React, { ForwardedRef } from 'react';
import { InteractionManager, Text, View } from 'react-native';
import { connect } from 'react-redux';
import parse from 'url-parse';
import moment from 'moment';
import * as Haptics from 'expo-haptics';
import { Model, Q } from '@nozbe/watermelondb';
import { dequal } from 'dequal';
import { withSafeAreaInsets } from 'react-native-safe-area-context';
import { StackNavigationProp } from '@react-navigation/stack';
import { RouteProp } from '@react-navigation/core';

import Touch from '../../utils/touch';
import { replyBroadcast as replyBroadcastAction } from '../../actions/messages';
import database from '../../lib/database';
import RocketChat from '../../lib/rocketchat';
import Message from '../../containers/message';
import MessageActions from '../../containers/MessageActions';
import MessageErrorActions from '../../containers/MessageErrorActions';
import MessageBox from '../../containers/MessageBox';
import log, { events, logEvent } from '../../utils/log';
import EventEmitter from '../../utils/events';
import I18n from '../../i18n';
import RoomHeader from '../../containers/RoomHeader';
import StatusBar from '../../containers/StatusBar';
import { themes } from '../../constants/colors';
import { MESSAGE_TYPE_ANY_LOAD, MESSAGE_TYPE_LOAD_MORE } from '../../constants/messageTypeLoad';
import debounce from '../../utils/debounce';
import ReactionsModal from '../../containers/ReactionsModal';
import { LISTENER } from '../../containers/Toast';
import { getBadgeColor, isBlocked, isTeamRoom, makeThreadName } from '../../utils/room';
import { isReadOnly } from '../../utils/isReadOnly';
import { isIOS, isTablet } from '../../utils/deviceInfo';
import { showErrorAlert } from '../../utils/info';
import { withTheme } from '../../theme';
import {
	KEY_COMMAND,
	handleCommandReplyLatest,
	handleCommandRoomActions,
	handleCommandScroll,
	handleCommandSearchMessages
} from '../../commands';
import { Review } from '../../utils/review';
import RoomClass from '../../lib/methods/subscriptions/room';
import { getUserSelector } from '../../selectors/login';
import { CONTAINER_TYPES } from '../../lib/methods/actions';
import Navigation from '../../lib/Navigation';
import SafeAreaView from '../../containers/SafeAreaView';
import { withDimensions } from '../../dimensions';
import { getHeaderTitlePosition } from '../../containers/Header';
import { E2E_MESSAGE_TYPE, E2E_STATUS } from '../../lib/encryption/constants';
import { takeInquiry } from '../../ee/omnichannel/lib';
import Loading from '../../containers/Loading';
import { goRoom } from '../../utils/goRoom';
import getThreadName from '../../lib/methods/getThreadName';
import getRoomInfo from '../../lib/methods/getRoomInfo';
import RoomServices from './services';
import LoadMore from './LoadMore';
import Banner from './Banner';
import Separator from './Separator';
import RightButtons from './RightButtons';
import LeftButtons from './LeftButtons';
import styles from './styles';
import JoinCode from './JoinCode';
import UploadProgress from './UploadProgress';
import ReactionPicker from './ReactionPicker';
import List from './List';
import { ChatsStackParamList } from '../../stacks/types';
import { IRoom, RoomType } from '../../definitions/IRoom';
import { IAttachment } from '../../definitions/IAttachment';

const stateAttrsUpdate = [
	'joined',
	'lastOpen',
	'reactionsModalVisible',
	'canAutoTranslate',
	'selectedMessage',
	'loading',
	'editing',
	'replying',
	'reacting',
	'readOnly',
	'member',
	'showingBlockingLoader'
];
const roomAttrsUpdate = [
	'f',
	'ro',
	'blocked',
	'blocker',
	'archived',
	'tunread',
	'muted',
	'ignored',
	'jitsiTimeout',
	'announcement',
	'sysMes',
	'topic',
	'name',
	'fname',
	'roles',
	'bannerClosed',
	'visitor',
	'joinCodeRequired',
	'teamMain',
	'teamId'
];

interface IRoomViewProps {
	navigation: StackNavigationProp<ChatsStackParamList, 'RoomView'>;
	route: RouteProp<ChatsStackParamList, 'RoomView'>;
	user: {
		id: string;
		username: string;
		token: string;
		showMessageInMainThread: boolean;
	};
	appState: string;
	useRealName: boolean;
	isAuthenticated: boolean;
	Message_GroupingPeriod: number;
	Message_TimeFormat: string;
	Message_Read_Receipt_Enabled: boolean;
	Hide_System_Messages: [];
	baseUrl: string;
	serverVersion: string;
	customEmojis: [key: string];
	isMasterDetail: boolean;
	theme: string;
	replyBroadcast: Function;
	width: number;
	height: number;
	insets: {
		left: number;
		right: number;
	};
}

export interface IRoomItem {
	id?: string;
	t: any;
	rid: string;
	tmid?: string;
	ts: Date;
	status?: any;
	u?: { _id: string };
	loaderItem: {
		t: string;
		ts: Date;
	};
}

interface INavToThread {
	id?: string;
	tmsg?: string;
	t?: any;
	e2e?: string;
	tmid?: string;
	tlm?: string;
}

class RoomView extends React.Component<IRoomViewProps, any> {
	private rid: string;
	private t: RoomType;
	private tmid?: string;
	private jumpToMessageId?: string;
	private jumpToThreadId?: string;
	private messagebox: React.RefObject<typeof MessageBox>;
	private list: React.RefObject<List>;
	private joinCode?: React.ForwardedRef<typeof JoinCode>;
	private flatList: any;
	private mounted: boolean;
	private sub?: RoomClass;
	private offset?: number;
	private didMountInteraction?: {
		then: (onfulfilled?: () => any, onrejected?: () => any) => Promise<any>;
		done: (...args: any[]) => any;
		cancel: () => void;
	};

	private willBlurListener?: { remove(): void };
	private subSubscription?: { unsubscribe(): void };
	private queryUnreads?: { unsubscribe(): void };
	private retryInit?: number;
	private retryInitTimeout?: ReturnType<typeof setTimeout>;
	private retryFindCount?: number;
	private retryFindTimeout?: ReturnType<typeof setTimeout>;
	private messageErrorActions?: React.ForwardedRef<typeof MessageErrorActions>;
	private messageActions?: React.ForwardedRef<typeof MessageActions>;

	constructor(props: IRoomViewProps) {
		super(props);
		console.time(`${this.constructor.name} init`);
		console.time(`${this.constructor.name} mount`);
		this.rid = props.route.params.rid;
		this.t = props.route.params.t;
		this.tmid = props.route.params?.tmid;
		const selectedMessage = props.route.params?.message;
		const name = props.route.params?.name;
		const fname = props.route.params?.fname;
		const prid = props.route.params?.prid;
		const room: any = props.route.params?.room ?? {
			rid: this.rid,
			t: this.t,
			name,
			fname,
			prid
		};
		this.jumpToMessageId = props.route.params?.jumpToMessageId;
		this.jumpToThreadId = props.route.params?.jumpToThreadId;
		const roomUserId = props.route.params?.roomUserId ?? RocketChat.getUidDirectMessage(room);
		this.state = {
			joined: true,
			room,
			roomUpdate: {},
			member: {},
			lastOpen: null,
			reactionsModalVisible: false,
			selectedMessage: selectedMessage || {},
			canAutoTranslate: false,
			loading: true,
			showingBlockingLoader: false,
			editing: false,
			replying: !!selectedMessage,
			replyWithMention: false,
			reacting: false,
			readOnly: false,
			unreadsCount: null,
			roomUserId
		};
		this.setHeader();

		if (room && room.observe) {
			this.observeRoom(room);
		} else if (this.rid) {
			this.findAndObserveRoom(this.rid);
		}

		this.setReadOnly();

		this.messagebox = React.createRef();
		this.list = React.createRef();
		this.joinCode = React.createRef();
		this.flatList = React.createRef();
		this.mounted = false;

		// we don't need to subscribe to threads
		if (this.rid && !this.tmid) {
			this.sub = new RoomClass(this.rid);
		}
		console.timeEnd(`${this.constructor.name} init`);
	}

	componentDidMount() {
		this.mounted = true;
		this.offset = 0;
		this.didMountInteraction = InteractionManager.runAfterInteractions(() => {
			const { isAuthenticated } = this.props;
			this.setHeader();
			if (this.rid) {
				this.sub?.subscribe?.();
				if (isAuthenticated) {
					this.init();
				} else {
					EventEmitter.addEventListener('connected', this.handleConnected);
				}
			}
			if (this.jumpToMessageId) {
				this.jumpToMessage(this.jumpToMessageId);
			}
			if (this.jumpToThreadId && !this.jumpToMessageId) {
				this.navToThread({ tmid: this.jumpToThreadId });
			}
			if (isIOS && this.rid) {
				this.updateUnreadCount();
			}
		});
		if (isTablet) {
			EventEmitter.addEventListener(KEY_COMMAND, this.handleCommands);
		}
		EventEmitter.addEventListener('ROOM_REMOVED', this.handleRoomRemoved);
		console.timeEnd(`${this.constructor.name} mount`);
	}

	shouldComponentUpdate(nextProps: IRoomViewProps, nextState: any) {
		const { state } = this;
		const { roomUpdate, member } = state;
		const { appState, theme, insets, route } = this.props;
		if (theme !== nextProps.theme) {
			return true;
		}
		if (appState !== nextProps.appState) {
			return true;
		}
		if (member.statusText !== nextState.member.statusText) {
			return true;
		}
		const stateUpdated = stateAttrsUpdate.some(key => nextState[key] !== state[key]);
		if (stateUpdated) {
			return true;
		}
		if (!dequal(nextProps.insets, insets)) {
			return true;
		}
		if (!dequal(nextProps.route?.params, route?.params)) {
			return true;
		}
		return roomAttrsUpdate.some(key => !dequal(nextState.roomUpdate[key], roomUpdate[key]));
	}

	componentDidUpdate(prevProps: IRoomViewProps, prevState: any) {
		const { roomUpdate } = this.state;
		const { appState, insets, route } = this.props;

		if (route?.params?.jumpToMessageId !== prevProps.route?.params?.jumpToMessageId) {
			this.jumpToMessage(route?.params?.jumpToMessageId);
		}

		if (route?.params?.jumpToThreadId !== prevProps.route?.params?.jumpToThreadId) {
			this.navToThread({ tmid: route?.params?.jumpToThreadId });
		}

		if (appState === 'foreground' && appState !== prevProps.appState && this.rid) {
			// Fire List.query() just to keep observables working
			if (this.list && this.list.current) {
				this.list.current?.query?.();
			}
		}
		// If it's not direct message
		if (this.t !== 'd') {
			if (roomUpdate.topic !== prevState.roomUpdate.topic) {
				this.setHeader();
			}
		}
		// If it's a livechat room
		if (this.t === 'l') {
			if (!dequal(prevState.roomUpdate.visitor, roomUpdate.visitor)) {
				this.setHeader();
			}
		}
		if (roomUpdate.teamMain !== prevState.roomUpdate.teamMain || roomUpdate.teamId !== prevState.roomUpdate.teamId) {
			this.setHeader();
		}
		if (
			(roomUpdate.fname !== prevState.roomUpdate.fname ||
				roomUpdate.name !== prevState.roomUpdate.name ||
				roomUpdate.teamMain !== prevState.roomUpdate.teamMain ||
				roomUpdate.teamId !== prevState.roomUpdate.teamId) &&
			!this.tmid
		) {
			this.setHeader();
		}
		if (insets.left !== prevProps.insets.left || insets.right !== prevProps.insets.right) {
			this.setHeader();
		}
		this.setReadOnly();
	}

	async componentWillUnmount() {
		const { editing, room } = this.state;
		const db = database.active;
		this.mounted = false;
		if (!editing && this.messagebox && this.messagebox.current) {
			const { text } = this.messagebox.current;
			let obj: any; // TODO - test the threadsCollection.find return to change this any;
			if (this.tmid) {
				try {
					const threadsCollection = db.get('threads');
					obj = await threadsCollection.find(this.tmid);
				} catch (e) {
					// Do nothing
				}
			} else {
				obj = room;
			}
			if (obj) {
				try {
					await db.action(async () => {
						await obj.update((r: any) => {
							// TODO - change this any
							r.draftMessage = text;
						});
					});
				} catch (error) {
					// Do nothing
				}
			}
		}
		this.unsubscribe();
		if (this.didMountInteraction && this.didMountInteraction.cancel) {
			this.didMountInteraction.cancel();
		}
		if (this.willBlurListener && this.willBlurListener.remove) {
			this.willBlurListener.remove();
		}
		if (this.subSubscription && this.subSubscription.unsubscribe) {
			this.subSubscription.unsubscribe();
		}
		if (this.queryUnreads && this.queryUnreads.unsubscribe) {
			this.queryUnreads.unsubscribe();
		}
		EventEmitter.removeListener('connected', this.handleConnected);
		if (isTablet) {
			EventEmitter.removeListener(KEY_COMMAND, this.handleCommands);
		}
		EventEmitter.removeListener('ROOM_REMOVED', this.handleRoomRemoved);
		console.countReset(`${this.constructor.name}.render calls`);
	}

	get isOmnichannel() {
		const { room } = this.state;
		return room.t === 'l';
	}

	setHeader = () => {
		const { room, unreadsCount, roomUserId, joined } = this.state;
		const { navigation, isMasterDetail, theme, baseUrl, user, insets, route } = this.props;
		const { rid, tmid } = this;
		const prid = room?.prid;
		const isGroupChat = RocketChat.isGroupChat(room);
		let title = route.params?.name;
		let parentTitle: string;
		if ((room.id || room.rid) && !tmid) {
			title = RocketChat.getRoomTitle(room);
		}
		if (tmid) {
			parentTitle = RocketChat.getRoomTitle(room);
		}
		const subtitle = room?.topic;
		const t = room?.t;
		const teamMain = room?.teamMain;
		const teamId = room?.teamId;
		const encrypted = room?.encrypted;
		const { id: userId, token } = user;
		const avatar = room?.name;
		const visitor = room?.visitor;
		if (!room?.rid) {
			return;
		}

		let numIconsRight = 2;
		if (tmid) {
			numIconsRight = 1;
		} else if (isTeamRoom({ teamId, joined })) {
			numIconsRight = 3;
		}
		const headerTitlePosition = getHeaderTitlePosition({ insets, numIconsRight });

		navigation.setOptions({
			headerShown: true,
			headerTitleAlign: 'left',
			headerTitleContainerStyle: {
				left: headerTitlePosition.left,
				right: headerTitlePosition.right
			},
			headerLeft: () => (
				<LeftButtons
					tmid={tmid}
					unreadsCount={unreadsCount}
					navigation={navigation}
					baseUrl={baseUrl}
					userId={userId}
					token={token}
					title={avatar}
					theme={theme}
					t={t}
					goRoomActionsView={this.goRoomActionsView}
					isMasterDetail={isMasterDetail}
				/>
			),
			headerTitle: () => (
				<RoomHeader
					rid={rid}
					prid={prid}
					tmid={tmid}
					title={title}
					teamMain={teamMain}
					parentTitle={parentTitle}
					subtitle={subtitle}
					type={t}
					roomUserId={roomUserId}
					visitor={visitor}
					isGroupChat={isGroupChat}
					onPress={this.goRoomActionsView}
					testID={`room-view-title-${title}`}
				/>
			),
			headerRight: () => (
				<RightButtons
					rid={rid}
					tmid={tmid}
					teamId={teamId}
					joined={joined}
					t={t}
					encrypted={encrypted}
					navigation={navigation}
					toggleFollowThread={this.toggleFollowThread}
				/>
			)
		});
	};

	// goRoomActionsView = (screen?: keyof ChatsStackParamList) => {
	goRoomActionsView = (screen?: any) => {
		logEvent(events.ROOM_GO_RA);
		const { room, member, joined } = this.state;
		const { navigation, isMasterDetail } = this.props;
		if (isMasterDetail) {
			navigation.navigate('ModalStackNavigator', {
				screen: screen ?? 'RoomActionsView',
				params: {
					rid: this.rid,
					t: this.t,
					room,
					member,
					showCloseModal: !!screen,
					joined
				}
			});
		} else {
			navigation.navigate('RoomActionsView', {
				rid: this.rid,
				t: this.t,
				room,
				member,
				joined
			});
		}
	};

	setReadOnly = async () => {
		const { room } = this.state;
		const { user } = this.props;
		const readOnly = await isReadOnly(room, user);
		this.setState({ readOnly });
	};

	init = async () => {
		try {
			this.setState({ loading: true });
			const { room, joined } = this.state;
			if (this.tmid) {
				await RoomServices.getThreadMessages(this.tmid, this.rid);
			} else {
				const newLastOpen = new Date();
				await RoomServices.getMessages(room);

				// if room is joined
				if (joined) {
					if (room.alert || room.unread || room.userMentions) {
						this.setLastOpen(room.ls);
					} else {
						this.setLastOpen(null);
					}
					// RoomServices.readMessages(room.rid, newLastOpen, true).catch(e => console.log(e)); this function receives true automatic
					RoomServices.readMessages(room.rid, newLastOpen).catch(e => console.log(e));
				}
			}

			const canAutoTranslate = RocketChat.canAutoTranslate();
			const member = await this.getRoomMember();

			this.setState({ canAutoTranslate, member, loading: false });
		} catch (e) {
			this.setState({ loading: false });
			this.retryInit = this.retryInit! + 1 || 1;
			if (this.retryInit <= 1) {
				this.retryInitTimeout = setTimeout(() => {
					this.init();
				}, 300);
			}
		}
	};

	getRoomMember = async () => {
		const { room } = this.state;
		const { t } = room;

		if (t === 'd' && !RocketChat.isGroupChat(room)) {
			try {
				const roomUserId = RocketChat.getUidDirectMessage(room);
				this.setState({ roomUserId }, () => this.setHeader());

				const result = await RocketChat.getUserInfo(roomUserId);
				if (result.success) {
					return result.user;
				}
			} catch (e) {
				log(e);
			}
		}

		return {};
	};

	findAndObserveRoom = async (rid: string) => {
		try {
			const db = database.active;
			const subCollection = await db.get('subscriptions');
			const room = await subCollection.find(rid);
			this.setState({ room });
			if (!this.tmid) {
				this.setHeader();
			}
			this.observeRoom(room);
		} catch (error) {
			if (this.t !== 'd') {
				console.log('Room not found');
				this.internalSetState({ joined: false });
			}
			if (this.rid) {
				// We navigate to RoomView before the Room is inserted to the local db
				// So we retry just to make sure we have the right content
				this.retryFindCount = this.retryFindCount! + 1 || 1;
				if (this.retryFindCount <= 3) {
					this.retryFindTimeout = setTimeout(() => {
						this.findAndObserveRoom(rid);
						this.init();
					}, 300);
				}
			}
		}
	};

	unsubscribe = async () => {
		if (this.sub && this.sub.unsubscribe) {
			await this.sub.unsubscribe();
		}
		delete this.sub;
	};

	observeRoom = (room: Model) => {
		const observable = room.observe();
		this.subSubscription = observable.subscribe((changes: any) => {
			const roomUpdate = roomAttrsUpdate.reduce((ret: any, attr: any) => {
				ret[attr] = changes[attr];
				return ret;
			}, {});
			if (this.mounted) {
				this.internalSetState({ room: changes, roomUpdate });
			} else {
				// @ts-ignore
				this.state.room = changes;
				// @ts-ignore
				this.state.roomUpdate = roomUpdate;
			}
		});
	};

	errorActionsShow = (message: string) => {
		// @ts-ignore
		this.messageErrorActions?.showMessageErrorActions(message);
	};

	onEditInit = (message: { id: string; subscription: { id: string }; attachments: any; msg: string }) => {
		const newMessage = {
			id: message.id,
			subscription: {
				id: message.subscription.id
			},
			msg: message?.attachments?.[0]?.description || message.msg
		};
		this.setState({ selectedMessage: newMessage, editing: true });
	};

	onEditCancel = () => {
		this.setState({ selectedMessage: {}, editing: false });
	};

	onEditRequest = async (message: string) => {
		this.setState({ selectedMessage: {}, editing: false });
		try {
			await RocketChat.editMessage(message);
		} catch (e) {
			log(e);
		}
	};

	onReplyInit = (message: string, mention: boolean) => {
		this.setState({
			selectedMessage: message,
			replying: true,
			replyWithMention: mention
		});
	};

	onReplyCancel = () => {
		this.setState({ selectedMessage: {}, replying: false, replyWithMention: false });
	};

	onReactionInit = (message: string) => {
		this.setState({ selectedMessage: message, reacting: true });
	};

	onReactionClose = () => {
		this.setState({ selectedMessage: {}, reacting: false });
	};

	onMessageLongPress = (message: string) => {
		// @ts-ignore
		this.messageActions?.showMessageActions(message);
	};

	showAttachment = (attachment: IAttachment) => {
		const { navigation } = this.props;
		navigation.navigate('AttachmentView', { attachment });
	};

	onReactionPress = async (shortname: string, messageId: string) => {
		try {
			await RocketChat.setReaction(shortname, messageId);
			this.onReactionClose();
			Review.pushPositiveEvent();
		} catch (e) {
			log(e);
		}
	};

	onReactionLongPress = (message: string) => {
		this.setState({ selectedMessage: message, reactionsModalVisible: true });
		Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
	};

	onCloseReactionsModal = () => {
		this.setState({ selectedMessage: {}, reactionsModalVisible: false });
	};

	onEncryptedPress = () => {
		logEvent(events.ROOM_ENCRYPTED_PRESS);
		const { navigation, isMasterDetail } = this.props;

		const screen: any = { screen: 'E2EHowItWorksView', params: { showCloseModal: true } };

		if (isMasterDetail) {
			return navigation.navigate('ModalStackNavigator', screen);
		}
		navigation.navigate('E2ESaveYourPasswordStackNavigator', screen);
	};

	onDiscussionPress = debounce(
		(item: any) => {
			const { navigation } = this.props;
			navigation.push('RoomView', {
				rid: item.drid,
				prid: item.rid,
				name: item.msg,
				t: RoomType.GROUP
			});
		},
		1000,
		true
	);

	// eslint-disable-next-line react/sort-comp
	updateUnreadCount = async () => {
		const db = database.active;
		const observable = await db.collections
			.get('subscriptions')
			.query(Q.where('archived', false), Q.where('open', true), Q.where('rid', Q.notEq(this.rid)))
			.observeWithColumns(['unread']);

		this.queryUnreads = observable.subscribe((data: any) => {
			const { unreadsCount } = this.state;
			const newUnreadsCount = data.filter((s: any) => s.unread > 0).reduce((a: any, b: any) => a + (b.unread || 0), 0);
			if (unreadsCount !== newUnreadsCount) {
				this.setState({ unreadsCount: newUnreadsCount }, () => this.setHeader());
			}
		});
	};

	onThreadPress = debounce((item: IRoomItem) => this.navToThread(item), 1000, true);

	shouldNavigateToRoom = (message: { tmid: string; rid: string }) => {
		if (message.tmid && message.tmid === this.tmid) {
			return false;
		}
		if (!message.tmid && message.rid === this.rid) {
			return false;
		}
		return true;
	};

	jumpToMessageByUrl = async (messageUrl: string) => {
		if (!messageUrl) {
			return;
		}
		try {
			this.setState({ showingBlockingLoader: true });
			const parsedUrl = parse(messageUrl, true);
			const messageId: any = parsedUrl.query.msg;
			await this.jumpToMessage(messageId);
			this.setState({ showingBlockingLoader: false });
		} catch (e) {
			this.setState({ showingBlockingLoader: false });
			log(e);
		}
	};

	jumpToMessage = async (messageId?: string) => {
		try {
			this.setState({ showingBlockingLoader: true });
			const message = await RoomServices.getMessageInfo(messageId!);

			if (!message) {
				return;
			}

			if (this.shouldNavigateToRoom(message)) {
				if (message.rid !== this.rid) {
					this.navToRoom(message);
				} else {
					this.navToThread(message);
				}
			} else {
				/**
				 * if it's from server, we don't have it saved locally and so we fetch surroundings
				 * we test if it's not from threads because we're fetching from threads currently with `getThreadMessages`
				 */
				if (message.fromServer && !message.tmid) {
					await RocketChat.loadSurroundingMessages({ messageId, rid: this.rid });
				}
				await Promise.race([this.list.current?.jumpToMessage(message.id), new Promise(res => setTimeout(res, 5000))]);
				this.list.current?.cancelJumpToMessage();
			}
		} catch (e) {
			log(e);
		} finally {
			this.setState({ showingBlockingLoader: false });
		}
	};

	replyBroadcast = (message: string) => {
		const { replyBroadcast } = this.props;
		replyBroadcast(message);
	};

	handleConnected = () => {
		this.init();
		EventEmitter.removeListener('connected', this.handleConnected);
	};

	handleRoomRemoved = ({ rid }: { rid: string }) => {
		const { room } = this.state;
		if (rid === this.rid) {
			Navigation.navigate('RoomsListView');
			!this.isOmnichannel &&
				showErrorAlert(I18n.t('You_were_removed_from_channel', { channel: RocketChat.getRoomTitle(room) }), I18n.t('Oops'));
		}
	};

	internalSetState = (...args: any) => {
		if (!this.mounted) {
			return;
		}
		// @ts-ignore
		this.setState(...args);
	};

	sendMessage = (message: string, tmid: string, tshow: string) => {
		logEvent(events.ROOM_SEND_MESSAGE);
		const { user } = this.props;
		RocketChat.sendMessage(this.rid, message, this.tmid || tmid, user, tshow).then(() => {
			if (this.list && this.list.current) {
				this.list.current.update();
			}
			this.setLastOpen(null);
			Review.pushPositiveEvent();
		});
	};

	getCustomEmoji = (name: any) => {
		const { customEmojis } = this.props;
		const emoji = customEmojis[name];
		if (emoji) {
			return emoji;
		}
		return null;
	};

	setLastOpen = (lastOpen: Date | null) => this.setState({ lastOpen });

	onJoin = () => {
		this.internalSetState({
			joined: true
		});
	};

	joinRoom = async () => {
		logEvent(events.ROOM_JOIN);
		try {
			const { room } = this.state;

			if (this.isOmnichannel) {
				await takeInquiry(room._id);
				this.onJoin();
			} else {
				const { joinCodeRequired } = room;
				if (joinCodeRequired) {
					// @ts-ignore
					this.joinCode?.current?.show();
				} else {
					await RocketChat.joinRoom(this.rid, null, this.t);
					this.onJoin();
				}
			}
		} catch (e) {
			log(e);
		}
	};

	getThreadName = (tmid: string, messageId?: string) => getThreadName(this.rid, tmid, messageId);

	toggleFollowThread = async (isFollowingThread: boolean, tmid: string) => {
		try {
			await RocketChat.toggleFollowMessage(tmid ?? this.tmid, !isFollowingThread);
			EventEmitter.emit(LISTENER, { message: isFollowingThread ? I18n.t('Unfollowed_thread') : I18n.t('Following_thread') });
		} catch (e) {
			log(e);
		}
	};

	getBadgeColor = (messageId?: string) => {
		const { room } = this.state;
		const { theme } = this.props;
		return getBadgeColor({ subscription: room, theme, messageId });
	};

	navToRoomInfo = (navParam: ChatsStackParamList['RoomInfoView']) => {
		const { navigation, user, isMasterDetail } = this.props;
		logEvent(events[`ROOM_GO_${navParam.t === 'd' ? 'USER' : 'ROOM'}_INFO`]);
		if (navParam.rid === user.id) {
			return;
		}
		if (isMasterDetail) {
			navParam.showCloseModal = true;
			navigation.navigate('ModalStackNavigator', { screen: 'RoomInfoView', params: navParam });
		} else {
			navigation.navigate('RoomInfoView', navParam);
		}
	};

	navToThread = async (item: INavToThread) => {
		const { roomUserId } = this.state;
		const { navigation } = this.props;

		if (item.tmid) {
			let name = item.tmsg;
			if (!name) {
				const result = await this.getThreadName(item.tmid, item.id);
				// test if there isn't a thread
				if (!result) {
					return;
				}
				name = result;
			}
			if (item.t === E2E_MESSAGE_TYPE && item.e2e !== E2E_STATUS.DONE) {
				name = I18n.t('Encrypted_message');
			}
			return navigation.push('RoomView', {
				rid: this.rid,
				tmid: item.tmid,
				name,
				t: RoomType.THREAD,
				roomUserId,
				jumpToMessageId: item.id
			});
		}

		if (item.tlm) {
			return navigation.push('RoomView', {
				rid: this.rid,
				tmid: item.id,
				name: makeThreadName(item),
				t: RoomType.THREAD,
				roomUserId
			});
		}
	};

	navToRoom = async (message: { rid: string; id: string }) => {
		const { navigation, isMasterDetail } = this.props;
		const roomInfo: any = await getRoomInfo(message.rid);
		return goRoom({
			item: roomInfo,
			isMasterDetail,
			navigationMethod: navigation.push,
			jumpToMessageId: message.id
		});
	};

	callJitsi = () => {
		const { room } = this.state;
		const { jitsiTimeout } = room;
		if (jitsiTimeout < Date.now()) {
			showErrorAlert(I18n.t('Call_already_ended'));
		} else {
			RocketChat.callJitsi(room);
		}
	};

	handleCommands = ({ event }: any) => {
		if (this.rid) {
			const { input } = event;
			if (handleCommandScroll(event)) {
				const offset: any = input === 'UIKeyInputUpArrow' ? 100 : -100;
				this.offset += offset;
				this.flatList?.scrollToOffset({ offset: this.offset });
			} else if (handleCommandRoomActions(event)) {
				this.goRoomActionsView();
			} else if (handleCommandSearchMessages(event)) {
				this.goRoomActionsView('SearchMessagesView');
			} else if (handleCommandReplyLatest(event)) {
				if (this.list && this.list.current) {
					const message = this.list.current.getLastMessage();
					this.onReplyInit(message, false);
				}
			}
		}
	};

	blockAction = ({ actionId, appId, value, blockId, rid, mid }: any) =>
		RocketChat.triggerBlockAction({
			blockId,
			actionId,
			value,
			mid,
			rid,
			appId,
			container: {
				type: CONTAINER_TYPES.MESSAGE,
				id: mid
			}
		});

	closeBanner = async () => {
		const { room } = this.state;
		try {
			const db = database.active;
			await db.action(async () => {
				await room.update((r: IRoom) => {
					r.bannerClosed = true;
				});
			});
		} catch {
			// do nothing
		}
	};

	isIgnored = (message: IRoomItem) => {
		const { room } = this.state;
		return room?.ignored?.includes?.(message?.u?._id) ?? false;
	};

	onLoadMoreMessages = (loaderItem: IRoomItem) =>
		RoomServices.getMoreMessages({
			rid: this.rid,
			tmid: this.tmid,
			t: this.t,
			loaderItem
		});

	renderItem = (item: IRoomItem, previousItem: IRoomItem, highlightedMessage: any) => {
		const { room, lastOpen, canAutoTranslate } = this.state;
		const { user, Message_GroupingPeriod, Message_TimeFormat, useRealName, baseUrl, Message_Read_Receipt_Enabled, theme } =
			this.props;
		let dateSeparator = null;
		let showUnreadSeparator = false;

		if (!previousItem) {
			dateSeparator = item.ts;
			showUnreadSeparator = moment(item.ts).isAfter(lastOpen);
		} else {
			showUnreadSeparator = lastOpen && moment(item.ts).isSameOrAfter(lastOpen) && moment(previousItem.ts).isBefore(lastOpen);
			if (!moment(item.ts).isSame(previousItem.ts, 'day')) {
				dateSeparator = item.ts;
			}
		}

		let content = null;
		if (MESSAGE_TYPE_ANY_LOAD.includes(item.t)) {
			content = (
				<LoadMore
					load={() => this.onLoadMoreMessages(item)}
					type={item.t}
					runOnRender={item.t === MESSAGE_TYPE_LOAD_MORE && !previousItem}
				/>
			);
		} else {
			content = (
				<Message
					item={item}
					user={user}
					rid={room.rid}
					archived={room.archived}
					broadcast={room.broadcast}
					status={item.status}
					isThreadRoom={!!this.tmid}
					isIgnored={this.isIgnored(item)}
					previousItem={previousItem}
					fetchThreadName={this.getThreadName}
					onReactionPress={this.onReactionPress}
					onReactionLongPress={this.onReactionLongPress}
					onLongPress={this.onMessageLongPress}
					onEncryptedPress={this.onEncryptedPress}
					onDiscussionPress={this.onDiscussionPress}
					onThreadPress={this.onThreadPress}
					onAnswerButtonPress={this.sendMessage}
					showAttachment={this.showAttachment}
					reactionInit={this.onReactionInit}
					replyBroadcast={this.replyBroadcast}
					errorActionsShow={this.errorActionsShow}
					baseUrl={baseUrl}
					Message_GroupingPeriod={Message_GroupingPeriod}
					timeFormat={Message_TimeFormat}
					useRealName={useRealName}
					isReadReceiptEnabled={Message_Read_Receipt_Enabled}
					autoTranslateRoom={canAutoTranslate && room.autoTranslate}
					autoTranslateLanguage={room.autoTranslateLanguage}
					navToRoomInfo={this.navToRoomInfo}
					getCustomEmoji={this.getCustomEmoji}
					callJitsi={this.callJitsi}
					blockAction={this.blockAction}
					threadBadgeColor={this.getBadgeColor(item?.id)}
					toggleFollowThread={this.toggleFollowThread}
					jumpToMessage={this.jumpToMessageByUrl}
					highlighted={highlightedMessage === item.id}
				/>
			);
		}

		if (showUnreadSeparator || dateSeparator) {
			return (
				<>
					{content}
					<Separator ts={dateSeparator} unread={showUnreadSeparator} theme={theme} />
				</>
			);
		}

		return content;
	};

	renderFooter = () => {
		const { joined, room, selectedMessage, editing, replying, replyWithMention, readOnly, loading } = this.state;
		const { navigation, theme, route } = this.props;

		const usedCannedResponse = route?.params?.usedCannedResponse;

		if (!this.rid) {
			return null;
		}
		if (!joined && !this.tmid) {
			return (
				<View style={styles.joinRoomContainer} key='room-view-join' testID='room-view-join'>
					<Text
						accessibilityLabel={I18n.t('You_are_in_preview_mode')}
						style={[styles.previewMode, { color: themes[theme].titleText }]}>
						{I18n.t('You_are_in_preview_mode')}
					</Text>
					<Touch
						onPress={this.joinRoom}
						style={[styles.joinRoomButton, { backgroundColor: themes[theme].actionTintColor }]}
						enabled={!loading}
						theme={theme}>
						<Text style={[styles.joinRoomText, { color: themes[theme].buttonText }]} testID='room-view-join-button'>
							{I18n.t(this.isOmnichannel ? 'Take_it' : 'Join')}
						</Text>
					</Touch>
				</View>
			);
		}
		if (readOnly) {
			return (
				<View style={styles.readOnly}>
					<Text
						style={[styles.previewMode, { color: themes[theme].titleText }]}
						accessibilityLabel={I18n.t('This_room_is_read_only')}>
						{I18n.t('This_room_is_read_only')}
					</Text>
				</View>
			);
		}
		if (isBlocked(room)) {
			return (
				<View style={styles.readOnly}>
					<Text style={[styles.previewMode, { color: themes[theme].titleText }]}>{I18n.t('This_room_is_blocked')}</Text>
				</View>
			);
		}
		return (
			<MessageBox
				ref={this.messagebox}
				onSubmit={this.sendMessage}
				rid={this.rid}
				tmid={this.tmid}
				roomType={room.t}
				isFocused={navigation.isFocused}
				theme={theme}
				message={selectedMessage}
				editing={editing}
				editRequest={this.onEditRequest}
				editCancel={this.onEditCancel}
				replying={replying}
				replyWithMention={replyWithMention}
				replyCancel={this.onReplyCancel}
				getCustomEmoji={this.getCustomEmoji}
				navigation={navigation}
				usedCannedResponse={usedCannedResponse}
			/>
		);
	};

	renderActions = () => {
		const { room, readOnly } = this.state;
		const { user } = this.props;
		return (
			<>
				<MessageActions
					ref={(ref: ForwardedRef<typeof MessageActions>) => (this.messageActions = ref)}
					tmid={this.tmid}
					room={room}
					user={user}
					editInit={this.onEditInit}
					replyInit={this.onReplyInit}
					reactionInit={this.onReactionInit}
					onReactionPress={this.onReactionPress}
					isReadOnly={readOnly}
				/>
				<MessageErrorActions
					ref={(ref: ForwardedRef<typeof MessageErrorActions>) => (this.messageErrorActions = ref)}
					tmid={this.tmid}
				/>
			</>
		);
	};

	render() {
		console.count(`${this.constructor.name}.render calls`);
		const { room, reactionsModalVisible, selectedMessage, loading, reacting, showingBlockingLoader } = this.state;
		const { user, baseUrl, theme, navigation, Hide_System_Messages, width, height, serverVersion } = this.props;
		const { rid, t, sysMes, bannerClosed, announcement } = room;

		return (
			<SafeAreaView style={{ backgroundColor: themes[theme].backgroundColor }} testID='room-view'>
				<StatusBar />
				<Banner
					title={I18n.t('Announcement')}
					text={announcement}
					bannerClosed={bannerClosed}
					closeBanner={this.closeBanner}
					theme={theme}
				/>
				<List
					ref={this.list}
					listRef={this.flatList}
					rid={rid}
					tmid={this.tmid}
					theme={theme}
					tunread={room?.tunread}
					ignored={room?.ignored}
					renderRow={this.renderItem}
					loading={loading}
					navigation={navigation}
					hideSystemMessages={Array.isArray(sysMes) ? sysMes : Hide_System_Messages}
					showMessageInMainThread={user.showMessageInMainThread}
					serverVersion={serverVersion}
				/>
				{this.renderFooter()}
				{this.renderActions()}
				<ReactionPicker
					show={reacting}
					message={selectedMessage}
					onEmojiSelected={this.onReactionPress}
					reactionClose={this.onReactionClose}
					width={width}
					height={height}
					theme={theme}
				/>
				<UploadProgress rid={this.rid} user={user} baseUrl={baseUrl} width={width} />
				<ReactionsModal
					message={selectedMessage}
					isVisible={reactionsModalVisible}
					user={user}
					baseUrl={baseUrl}
					onClose={this.onCloseReactionsModal}
					getCustomEmoji={this.getCustomEmoji}
				/>
				<JoinCode ref={this.joinCode} onJoin={this.onJoin} rid={rid} t={t} theme={theme} />
				<Loading visible={showingBlockingLoader} />
			</SafeAreaView>
		);
	}
}

const mapStateToProps = (state: any) => ({
	user: getUserSelector(state),
	isMasterDetail: state.app.isMasterDetail,
	appState: state.app.ready && state.app.foreground ? 'foreground' : 'background',
	useRealName: state.settings.UI_Use_Real_Name,
	isAuthenticated: state.login.isAuthenticated,
	Message_GroupingPeriod: state.settings.Message_GroupingPeriod,
	Message_TimeFormat: state.settings.Message_TimeFormat,
	customEmojis: state.customEmojis,
	baseUrl: state.server.server,
	serverVersion: state.server.version,
	Message_Read_Receipt_Enabled: state.settings.Message_Read_Receipt_Enabled,
	Hide_System_Messages: state.settings.Hide_System_Messages
});

const mapDispatchToProps = (dispatch: any) => ({
	replyBroadcast: (message: any) => dispatch(replyBroadcastAction(message))
});

export default connect(mapStateToProps, mapDispatchToProps)(withDimensions(withTheme(withSafeAreaInsets(RoomView))));