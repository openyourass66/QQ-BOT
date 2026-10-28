using System;
using System.Collections;
using System.Collections.Generic;
using System.Globalization;
using System.Linq;
using System.Windows;
using System.Windows.Controls;
using System.Windows.Media;
using Forms = System.Windows.Forms;

partial class App
{
    class FieldSpec {
        public string Path, Category, Card, Title, Help, Unit;
        public long Min, Max, Step;
        public FieldSpec(string path, string category, string card, string title, string help, string unit = "", long min = 0, long max = 10000, long step = 1) { Path=path; Category=category; Card=card; Title=title; Help=help; Unit=unit; Min=min; Max=max; Step=step; }
    }
    public class SettingsCategory { public string Name { get; set; } public string Description { get; set; } public string Count { get; set; } }
    class FieldView { public FieldSpec Spec; public FrameworkElement Row, Editor; public TextBlock Error, Status; }
    static HashSet<string> dirtySettingPaths = new HashSet<string>();
    static Dictionary<string,string> savedSettingValues = new Dictionary<string,string>();
    static string settingsPath = "";
    class SettingsCard { public string Category; public Border Surface; public List<FieldView> Rows = new List<FieldView>(); }
    static List<SettingsCard> settingsCards = new List<SettingsCard>();
    class SettingsLink { public string Category, Search; public Border Surface; public TextBlock Summary; }
    static List<SettingsLink> settingsLinks = new List<SettingsLink>();
    static Dictionary<string, FieldView> fieldViews = new Dictionary<string, FieldView>();
    static string selectedCategory = "对话与参与";
    static readonly string[] categoryNames = { "对话与参与", "功能开关", "主动与提醒", "额度与节奏", "联系范围", "身份与审批", "记录保留" };
    static readonly string[] categoryDescriptions = {
        "决定什么时候回应，以及如何自然地参与聊天。", "决定允许使用哪些能力；模型与服务在连接与运行配置。", "管理后台活动、联系间隔与安静时段；每日额度集中在额度与节奏。", "集中管理每日额度与回复节奏。", "管理允许与屏蔽名单；动作确认统一在身份与审批设置。", "管理机器人名称、管理员，以及 QQ 动作和工作区操作的确认规则。", "控制消息记录的保留时间与条数；文件位置在连接与运行管理。"
    };
    static readonly FieldSpec[] fieldSpecs = {
        new FieldSpec("learning.memory", "功能开关", "记忆与群内学习", "自动整理群友记忆", "仅分析明确开启的会话；提案经来源与版本校验后保存。"),
        new FieldSpec("learning.lexicon", "功能开关", "记忆与群内学习", "学习群内用语与表达", "至少三条消息、两位发送者支持，并由你确认后使用。"),
        new FieldSpec("learning.useLexicon", "功能开关", "记忆与群内学习", "使用已确认群内用语", "暂停学习后仍可使用已确认词条；关闭本项暂停注入表达参考。"),
        new FieldSpec("learning.chats", "功能开关", "记忆与群内学习", "允许学习的会话", "用逗号分隔，例如 group:123456、private:654321；空列表不学习。"),
        new FieldSpec("learning.minMessages", "主动与提醒", "后台资料整理", "积累新消息数量", "只分析有效用户文字，不包含机器人回复与撤回消息。", "条", 3, 200),
        new FieldSpec("learning.intervalMinutes", "主动与提醒", "后台资料整理", "同会话整理间隔", "记忆与群内用语共用一次分析；普通聊天优先。", "分钟", 5, 1440, 5),
        new FieldSpec("learning.idleMinutes", "主动与提醒", "后台资料整理", "聊天空闲时间", "聊天安静后再开始整理。", "分钟", 1, 60),
        new FieldSpec("learning.dailyCalls", "额度与节奏", "后台任务额度", "每日后台学习上限", "全局共享，上海零点重置；失败或未知请求保留次数。", "次/天", 0, 100),
        new FieldSpec("learning.memoryCount", "对话与参与", "记忆与用语召回", "每轮相关记忆条数", "优先当前发言者和话题；0 表示不自动注入。", "条", 0, 30),
        new FieldSpec("learning.memoryChars", "对话与参与", "记忆与用语召回", "每轮记忆字数", "按完整条目筛选，不在事实中间截断。", "字", 0, 6000, 100),
        new FieldSpec("learning.lexiconCount", "对话与参与", "记忆与用语召回", "每轮群内用语条数", "只使用当前群已确认且相关的词条。", "条", 0, 10),
        new FieldSpec("learning.lexiconChars", "对话与参与", "记忆与用语召回", "每轮用语字数", "表达参考不会改写人设。", "字", 0, 2000, 100),
        new FieldSpec("context.backgroundChars", "对话与参与", "上下文预算", "附加群聊字数上限", "仅限制附加背景，保留当前问题。", "字", 500, 12000, 500),
        new FieldSpec("context.warningPercent", "额度与节奏", "上下文管理", "上下文提醒比例", "依赖 DSH 上报；上下文占用不等于计费用量。", "%", 30, 95, 5),
        new FieldSpec("context.activeSessions", "额度与节奏", "上下文管理", "活跃模型会话上限", "达到上限时释放较早的空闲会话；历史映射保留，下次聊天可恢复。", "个", 4, 512),
        new FieldSpec("context.idleMinutes", "额度与节奏", "上下文管理", "空闲会话释放时间", "等待模型进程确认释放后才腾出名额；处理中的会话保持有效。", "分钟", 1, 1440),
        new FieldSpec("context.rollover", "额度与节奏", "上下文管理", "高占用时更换会话", "默认沿用 DSH 压缩；开启后在下一轮交接近期记录。"),
        new FieldSpec("context.rolloverPercent", "额度与节奏", "上下文管理", "会话更换比例", "新会话及映射保存成功后才替换旧会话。", "%", 50, 99),
        new FieldSpec("context.toolsPerTurn", "额度与节奏", "工具预算", "每轮工具调用上限", "QQ 工具与原生搜索、网页读取共享；达到上限后停止本轮工具。", "次", 1, 200),
        new FieldSpec("requests.perDay", "额度与节奏", "服务请求额度", "每日服务请求总量", "模型生成、压缩、独立媒体、后台学习和原生联网共享；失败或结果未知仍计次。", "次/天", 0, 10000),
        new FieldSpec("requests.perUserPerDay", "额度与节奏", "服务请求额度", "每位用户每日请求量", "限制由这位用户触发的服务请求；同时受总量和会话额度限制。", "次/天", 0, 10000),
        new FieldSpec("requests.perChatPerDay", "额度与节奏", "服务请求额度", "每个会话每日请求量", "群聊与私聊各自累计；同时受每日总量限制。", "次/天", 0, 10000),
        new FieldSpec("requests.backgroundPerDay", "额度与节奏", "服务请求额度", "每日后台服务请求量", "主动行动和后台学习共享，避免无人交互时持续请求。", "次/天", 0, 1000),
        new FieldSpec("requests.mediaPerDay", "额度与节奏", "服务请求额度", "每日独立媒体请求量", "独立看图、语音识别和语音合成共享；图片随当前对话模型发送时不重复计次。", "次/天", 0, 1000),
        new FieldSpec("requests.nativeWebPerDay", "额度与节奏", "服务请求额度", "每日原生联网调用量", "搜索与网页读取共享；同时受服务总量和每轮工具上限限制。", "次/天", 0, 1000),
        new FieldSpec("requests.perMinute", "额度与节奏", "请求节奏与大小", "每分钟服务请求量", "按最近一分钟统计，限制突发请求。", "次", 1, 1000),
        new FieldSpec("requests.perTurn", "额度与节奏", "请求节奏与大小", "每轮服务请求量", "包含模型续答、重试及压缩；工具调用另受共享工具上限限制。", "次", 1, 100),
        new FieldSpec("requests.concurrent", "额度与节奏", "请求节奏与大小", "同时执行的服务请求量", "所有会话、后台任务和媒体服务共享。", "个", 1, 16),
        new FieldSpec("requests.maxOutputTokens", "额度与节奏", "请求节奏与大小", "单次最大输出 Token", "提交给模型的输出上限；计费只记录服务实际上报值。降低后若压缩被阻止，请重新连接模型。", "Token", 128, 32768, 128),
        new FieldSpec("requests.maxRequestKiB", "额度与节奏", "请求节奏与大小", "单次请求材料大小", "包括上下文、工具定义及图片等材料，超过上限时停止提交。", "KiB", 64, 32768, 64),
        new FieldSpec("requests.maxResponseChars", "额度与节奏", "请求节奏与大小", "单次返回内容字数", "限制文本、推理内容及工具参数总量；超过上限中止本轮。", "字", 1000, 128000, 1000),
        new FieldSpec("context.filterTools", "功能开关", "能力清单", "按可用条件提供 QQ 工具", "配置变化在下一轮更换会话；执行时重新校验。"),
        new FieldSpec("chat.privateAutoReply", "对话与参与", "参与方式", "自动回复私聊", "收到好友私聊后，允许小鲸自然回应。"),
        new FieldSpec("social.responseMode", "对话与参与", "参与方式", "群聊参与方式", "直接找小鲸的消息仍会优先回应。"),
        new FieldSpec("chat.group.requireMention", "对话与参与", "参与方式", "仅被叫到时回应", "选择“沿用群聊开关”时，使用这个设置。"),
        new FieldSpec("chat.group.prefix", "对话与参与", "参与方式", "触发前缀", "群友以这个前缀开头，也能直接找小鲸聊天。"),
        new FieldSpec("social.keywords", "对话与参与", "参与方式", "参与关键词", "匹配这些话题时加入聊天；多个词用逗号分隔。"),
        new FieldSpec("social.responseProbability", "对话与参与", "参与方式", "旁聊参与概率", "概率模式下，决定参与普通群聊的机会。", "%", 0, 100, 5),
        new FieldSpec("chat.group.contextLines", "对话与参与", "上下文与跟进", "附加聊天记录", "每轮附带的近期群聊；0 表示不附加。", "条", 0, 30),
        new FieldSpec("chat.group.followUpMs", "对话与参与", "上下文与跟进", "连续追问窗口", "回应后，允许同一群友不重新 @ 继续追问。", "毫秒", 0, 600000, 1000),
        new FieldSpec("social.batchWindowMs", "对话与参与", "上下文与跟进", "消息聚合窗口", "稍等片刻，将连发的几句话放在一起处理。", "毫秒", 0, 5000, 100),
        new FieldSpec("social.activeMinutes", "对话与参与", "上下文与跟进", "话题活跃时间", "参与一个话题后，可以持续跟进的时间。", "分钟", 0, 60),
        new FieldSpec("chat.group.cooldownMs", "对话与参与", "上下文与跟进", "普通群聊冷却", "控制旁聊回应的频率，直接对话不受此项限制。", "毫秒", 0, 60000, 500),
        new FieldSpec("social.autonomy", "身份与审批", "QQ 动作确认", "QQ 动作确认方式", "自主执行、仅敏感动作确认，或所有动作确认；不控制工作区命令与文件审批。"),
        new FieldSpec("social.allowAll", "联系范围", "联系人范围", "允许现有好友和群", "允许联系已有对象；屏蔽名单始终优先。"),
        new FieldSpec("social.allowedGroups", "联系范围", "联系人范围", "允许的群号", "关闭“允许现有好友和群”后生效；用逗号分隔。"),
        new FieldSpec("social.allowedUsers", "联系范围", "联系人范围", "允许的好友 QQ", "关闭“允许现有好友和群”后生效；用逗号分隔。"),
        new FieldSpec("social.blockedGroups", "联系范围", "屏蔽名单", "屏蔽的群", "这些群不触发回应，也不接收主动消息。"),
        new FieldSpec("social.blockedUsers", "联系范围", "屏蔽名单", "屏蔽的用户", "这些用户的后续发言不会进入模型上下文。"),
        new FieldSpec("social.memoryEnabled", "功能开关", "日常能力", "群友长期记忆", "记住偏好与重要事实；内容在人设与记忆中统一编辑。"),
        new FieldSpec("social.stickersEnabled", "功能开关", "日常能力", "QQ 收藏表情", "允许同步、理解、查找和发送表情；具体收藏在 QQ 活动中管理。"),
        new FieldSpec("social.mediaEnabled", "功能开关", "日常能力", "图片、语音与视频", "控制媒体工具是否可用；模型、声音和视频参数统一在媒体服务配置。"),
        new FieldSpec("social.filesEnabled", "功能开关", "日常能力", "文件收发", "允许制作文本、接收文件和发送媒体库文件。"),
        new FieldSpec("social.requestsEnabled", "功能开关", "日常能力", "好友与群申请", "允许理解并处理真实收到的申请和邀请。"),
        new FieldSpec("features.qzone.enabled", "功能开关", "日常能力", "QQ 空间发布", "依赖协议端的空间接口支持；发布确认规则在身份与审批管理。"),
        new FieldSpec("features.qzone.browseEnabled", "功能开关", "QQ 空间互动", "空间浏览", "读取自己或指定好友的说说；直接复用 NapCat 登录，可在扩展服务检查连接。"),
        new FieldSpec("features.qzone.commentsEnabled", "功能开关", "QQ 空间互动", "空间评论与回复", "需先开启空间浏览，只能评论当前会话实际读到的动态；好友空间受联系范围限制。"),
        new FieldSpec("features.qzone.commentRequireConfirm", "身份与审批", "QQ 动作确认", "空间评论前确认", "确认时显示动态作者、动态内容及评论正文；敏感或全部确认模式仍要求审批。"),
        new FieldSpec("features.qzone.requireConfirm", "身份与审批", "QQ 动作确认", "空间发布前确认", "即使选择自主执行，开启此项后，空间发布仍需确认实际正文与图片。"),
        new FieldSpec("social.visionModel", "媒体服务", "模型与声音", "独立视觉模型", "留空沿用对话模型；填写时使用本页上方的媒体服务。"),
        new FieldSpec("social.transcriptionModel", "媒体服务", "模型与声音", "语音转写模型", "使用本页上方的媒体服务；留空表示未配置语音识别。"),
        new FieldSpec("social.speechModel", "媒体服务", "模型与声音", "语音合成模型", "使用本页上方的媒体服务；留空表示未配置语音合成。"),
        new FieldSpec("social.speechVoice", "媒体服务", "模型与声音", "合成声音", "填写语音合成服务支持的声音名称。"),
        new FieldSpec("social.videoFrames", "媒体服务", "模型与声音", "视频抽帧数量", "需要本页配置的 FFmpeg 和可用视觉能力。", "帧", 1, 12),
        new FieldSpec("social.remindersEnabled", "主动与提醒", "定时提醒", "定时提醒", "周期错过整段时跳过积压，一次提醒迟到超过24小时停止补发；结果未知不自动重发。"),
        new FieldSpec("social.proactiveEnabled", "主动与提醒", "后台活动", "后台自主活动", "后台聊天、挑选表情和空间创作的总开关；定时提醒独立控制。"),
        new FieldSpec("social.proactiveIntervalMinutes", "主动与提醒", "后台活动", "聊天静置时间", "会话安静多久后开始考虑主动联系；收藏、到期想法和空间任务独立调度，不受此等待时间拖延。", "分钟", 5, 1440, 5),
        new FieldSpec("social.autonomousEnabled", "主动与提醒", "兴趣与想法", "持续兴趣与想法", "结合实际互动积累兴趣和未完话题；关闭后暂停自主判断。"),
        new FieldSpec("social.personalInterests", "主动与提醒", "兴趣与想法", "全局创作兴趣", "空间独立创作可使用这些公开主题；多个主题用逗号分隔。聊天中的兴趣保留在原会话。"),
        new FieldSpec("social.autonomousDecisionsPerDay", "额度与节奏", "后台任务额度", "每日后台判断上限", "候选想法才会唤醒模型；没有内容时可以安静结束。", "次/天", 0, 200),
        new FieldSpec("social.autonomousChatCooldownMinutes", "主动与提醒", "兴趣与想法", "同会话主动间隔", "主动联系后至少等待这段时间；对方未回应时暂停再次主动聊天。", "分钟", 5, 10080, 5),
        new FieldSpec("social.autoCollectStickers", "主动与提醒", "表情习惯", "后台挑选表情收藏", "收到图片后结合含义和兴趣判断，需开启后台自主活动和持续兴趣与想法。"),
        new FieldSpec("social.autoCollectPerDay", "额度与节奏", "后台任务额度", "每日后台新增收藏", "后台任务新增到 QQ 收藏的上限；同图复用不重复占用。", "张/天", 0, 100),
        new FieldSpec("social.stickerRepeatHours", "主动与提醒", "表情习惯", "主动表情重复间隔", "自主聊天在同一会话中避免反复发送同一张表情。", "小时", 0, 168),
        new FieldSpec("social.autoQzoneEnabled", "主动与提醒", "自主空间分享", "自主空间创作", "使用独立会话和公开兴趣创作，需开启 QQ 空间发布、后台自主活动和持续兴趣与想法。"),
        new FieldSpec("social.autoQzonePerDay", "额度与节奏", "后台任务额度", "每日自主空间上限", "同时受空间总额度约束；没有内容时可以一天不发。", "条/天", 0, 10),
        new FieldSpec("social.qzoneIntervalHours", "主动与提醒", "自主空间分享", "空间创作判断间隔", "每次判断后间隔至少这么久，避免反复生成相似内容。", "小时", 1, 168),
        new FieldSpec("social.autoQzoneCommentEnabled", "主动与提醒", "自主空间互动", "自主浏览与评论好友空间", "定时查看允许好友近期的新说说，有具体想法时自行评论；仍受空间浏览、评论开关、额度和确认规则约束。"),
        new FieldSpec("social.autoQzoneCommentUsers", "主动与提醒", "自主空间互动", "自主评论的好友 QQ", "多个 QQ 用逗号分隔；留空表示所有允许联系的好友。跳过禁止后台活动的好友，不引用私聊或群聊经历。"),
        new FieldSpec("social.qzoneCommentIntervalMinutes", "主动与提醒", "自主空间互动", "好友空间检查间隔", "每次轮换一位好友，只判断近 24 小时的新动态；已评论或结果待核对的动态不会自主重复评论。", "分钟", 5, 1440, 5),
        new FieldSpec("chat.group.proactive.enabled", "主动与提醒", "群聊与安静时段", "允许群主动消息与提醒", "群内后台聊天、跨群发送和群提醒共同使用此权限。"),
        new FieldSpec("social.quietStartHour", "主动与提醒", "群聊与安静时段", "安静时段开始", "按上海时间暂停后台聊天、收藏与空间创作；约定提醒不受影响。", "时", 0, 23),
        new FieldSpec("social.quietEndHour", "主动与提醒", "群聊与安静时段", "安静时段结束", "开始与结束相同表示不设置安静时段。", "时", 0, 23),
        new FieldSpec("social.actionsPerDay", "额度与节奏", "每日额度", "QQ 动作总额", "0 表示禁止；按上海时间每天零点重置。", "次/天", 0, 10000, 10),
        new FieldSpec("budgets.proactiveMessagesPerDay", "额度与节奏", "每日额度", "主动消息", "跨会话发送与主动聊天共享；定时提醒使用独立额度。", "条/天", 0, 100),
        new FieldSpec("budgets.remindersPerDay", "额度与节奏", "每日额度", "定时提醒", "独立于主动聊天额度；群提醒仍受群主动开关及每群额度约束。", "条/天", 0, 100),
        new FieldSpec("chat.group.proactive.perGroupPerDay", "额度与节奏", "每日额度", "每群主动消息与提醒", "群内主动消息和提醒共用此额度，各自再受对应全局额度约束。", "条/天", 0, 20),
        new FieldSpec("budgets.likesPerDay", "额度与节奏", "每日额度", "名片点赞", "按实际点赞次数扣除。", "次/天", 0, 200, 5),
        new FieldSpec("features.qzone.dailyLimit", "额度与节奏", "每日额度", "空间发布总额", "对话中的发布与后台自主发布共用；后台另受自主空间上限约束。", "次/天", 0, 10),
        new FieldSpec("features.qzone.commentDailyLimit", "额度与节奏", "每日额度", "空间评论总额", "评论与回复共用；发送失败或结果未知保留次数，上海零点重置。", "次/天", 0, 50),
        new FieldSpec("social.messagesPerMinute", "额度与节奏", "回复节奏", "会话操作频率", "限制同一会话一分钟内的动作次数。", "次/分", 1, 100),
        new FieldSpec("chat.delay.minMs", "额度与节奏", "回复节奏", "最短回复延迟", "最短延迟不能大于最长延迟。", "毫秒", 0, 10000, 100),
        new FieldSpec("chat.delay.maxMs", "额度与节奏", "回复节奏", "最长回复延迟", "在范围内选择自然的发送间隔。", "毫秒", 0, 20000, 100),
        new FieldSpec("chat.delay.chunkSize", "额度与节奏", "回复节奏", "长消息分段", "超过这个长度时分条发送。", "字", 100, 4000, 100),
        new FieldSpec("identity.name", "身份与审批", "小鲸的身份", "机器人名称", "群友在句首叫这个名字，也能唤起小鲸。"),
        new FieldSpec("approval.adminQq", "身份与审批", "审批接收人", "管理员 QQ", "接收 QQ 动作和工作区操作的审批；0 表示未设置。", "", 0, 9007199254740991),
        new FieldSpec("approval.allowExec", "身份与审批", "工作区审批", "旧版命令执行设置", "当前受限运行模式关闭本地命令和文件工具；保留旧值用于兼容，不能用它开放权限。"),
        new FieldSpec("approval.timeoutMs", "身份与审批", "审批接收人", "审批等待时间", "QQ 动作和工作区操作共用；超时后取消本次审批。", "毫秒", 5000, 600000, 5000),
        new FieldSpec("social.retentionDays", "记录保留", "消息记录", "消息保留时间", "过期消息会在后续保存时淘汰。", "天", 1, 365),
        new FieldSpec("social.messagesPerChat", "记录保留", "消息记录", "每会话消息上限", "保留最近的消息，不影响独立存储的长期记忆。", "条", 80, 20000, 100)
    };
    static Brush Ink(string key) { return (Brush)Application.Current.Resources[key]; }
    static Brush Color(string value) { return (Brush)new BrushConverter().ConvertFromString(value); }
    static void InitSettingsView() {
        var nav = Find<ListBox>("SettingsNav");
        nav.SelectionChanged += (s,e) => { var item = nav.SelectedItem as SettingsCategory; if (item != null) { selectedCategory=item.Name; FilterSettings(); Find<ScrollViewer>("SettingsScroll").ScrollToTop(); } };
        Find<TextBox>("SettingsSearch").TextChanged += (s,e) => FilterSettings();
        Find<TextBox>("SettingsSearch").KeyDown += (s,e) => { if(e.Key==System.Windows.Input.Key.Escape){Find<TextBox>("SettingsSearch").Clear();e.Handled=true;} };
    }
    static Dictionary<string,object> FlattenSettings(Dictionary<string,object> data, string prefix = "") {
        var result = new Dictionary<string,object>();
        foreach (var pair in data) { if(prefix.Length==0&&pair.Key=="installation")continue;var nested=pair.Value as Dictionary<string,object>; if(nested!=null) foreach(var child in FlattenSettings(nested,prefix+pair.Key+".")) result[child.Key]=child.Value; else result[prefix+pair.Key]=pair.Value; }
        return result;
    }
    static void BuildSettings(Dictionary<string,object> data, StackPanel panel) {
        panel.Children.Clear(); fields.Clear(); fieldViews.Clear(); settingsCards.Clear();settingsLinks.Clear();mediaInputs.Clear();
        var values=FlattenSettings(data);
        savedSettingValues=values.ToDictionary(pair=>pair.Key,pair=>json.Serialize(pair.Value));dirtySettingPaths.Clear();
        var specs=fieldSpecs.Where(s=>values.ContainsKey(s.Path)).ToList();
        foreach(var pair in values.Where(p=>!specs.Any(s=>s.Path==p.Key))) specs.Add(new FieldSpec(pair.Key,"记录保留","其他设置",Label(pair.Key.Split('.').Last()),"按项目配置规则保存。"));
        foreach(var spec in specs.Where(s=>!categoryNames.Contains(s.Category))) {var view=MakeSetting(spec,values[spec.Path]);fieldViews[spec.Path]=view;}
        foreach(var category in categoryNames) foreach(var group in specs.Where(s=>s.Category==category).GroupBy(s=>s.Card)) {
            var body=new StackPanel();
            var title=new DockPanel { Margin=new Thickness(0,0,0,5) };
            var number=new TextBlock { Text=group.Count()+" 项", Foreground=Ink("Muted"), FontSize=10, HorizontalAlignment=HorizontalAlignment.Right }; DockPanel.SetDock(number,Dock.Right); title.Children.Add(number);
            title.Children.Add(new TextBlock { Text=group.Key, FontSize=14, FontWeight=FontWeights.SemiBold }); body.Children.Add(title);
            var card=new SettingsCard { Category=category, Surface=new Border { Background=Brushes.White, CornerRadius=new CornerRadius(12), BorderBrush=Ink("Line"), BorderThickness=new Thickness(1), Padding=new Thickness(20,16,20,7), Margin=new Thickness(0,0,0,14), Child=body } };
            bool compact=group.All(s=>values[s.Path] is bool)||group.All(s=>!(values[s.Path] is string)&&!(values[s.Path] is bool)&&!(values[s.Path] is IEnumerable));
            Panel rows=compact?(Panel)new System.Windows.Controls.Primitives.UniformGrid {Columns=2}:new StackPanel();body.Children.Add(rows);
            int index=0;
            foreach(var spec in group) { var view=MakeSetting(spec,values[spec.Path],compact);if(compact)view.Row.Margin=new Thickness(index%2==0?0:12,0,index%2==0?12:0,7);index++;card.Rows.Add(view);rows.Children.Add(view.Row);fieldViews[spec.Path]=view; }
            settingsCards.Add(card);panel.Children.Add(card.Surface);
        }
        Find<ListBox>("SettingsNav").ItemsSource=categoryNames.Select((name,i)=>new SettingsCategory { Name=name, Description=categoryDescriptions[i], Count=specs.Count(s=>s.Category==name).ToString() }).ToList();
        Find<ListBox>("SettingsNav").SelectedItem=((IEnumerable<SettingsCategory>)Find<ListBox>("SettingsNav").ItemsSource).First(c=>c.Name==selectedCategory);
        AddSettingsLink(panel,"功能开关","记忆内容与收藏","记忆 人设 收藏 表情","长期记忆在人设与记忆中编辑，收藏表情在 QQ 活动中管理。","管理长期记忆",()=>OpenFriendMemory(null));
        AddSettingsLink(panel,"功能开关","空间连接与后台分析","空间 连接 NapCat 后台 分析","空间直接复用 NapCat 登录；扩展服务中可检查空间连接，也可配置后台分析模型。","检查空间连接",()=>NavigateRuntime(4));
        AddSettingsLink(panel,"功能开关","联网搜索","联网 搜索 网页 DeepSeek DSH","联网搜索与网页读取由 DSH / DeepSeek 原生工具提供，使用当前 Profile 与凭据。","查看模型与运行环境",()=>NavigateRuntime(1));
        AddSettingsLink(panel,"联系范围","动作确认规则","确认 审批 权限 管理员","允许联系哪些对象在本页管理；QQ 动作是否需要确认由身份与审批管理。","设置动作确认",()=>NavigateSetting("social.autonomy"));
        AddSettingsLink(panel,"主动与提醒","后台任务额度","额度 判断 收藏 空间 每天 上限","主动聊天、提醒和后台任务的每日额度统一在额度与节奏设置。","设置每日额度",()=>NavigateSetting("social.autonomousDecisionsPerDay"));
        AddSettingsLink(panel,"额度与节奏","后台活动开关","后台 主动 收藏 空间 开关","本页设置每日上限；是否启用后台聊天、收藏和空间创作在主动与提醒管理。","设置后台活动",()=>NavigateSetting("social.proactiveEnabled"));
        AddSettingsLink(panel,"记录保留","存储位置与记忆文件","目录 路径 工作区 存储 文件 记忆","本页只管理消息保留范围；存储路径在连接与运行设置，长期记忆文件在人设与记忆管理。","设置存储位置",()=>NavigateRuntime(5));
        Find<TextBlock>("SettingsCount").Text=specs.Count(s=>categoryNames.Contains(s.Category))+" 项行为设置 · "+categoryNames.Length+" 个分类 · 媒体参数见连接与运行";
        RefreshDependencies();FilterSettings();
    }
    static FieldView MakeSetting(FieldSpec spec, object value, bool compact=false) {
        var outer=new StackPanel { Margin=new Thickness(0,0,0,7) };
        var row=new Grid { Margin=new Thickness(0,12,0,3) };
        row.ColumnDefinitions.Add(new ColumnDefinition());row.ColumnDefinitions.Add(new ColumnDefinition { Width=new GridLength(value is bool?76:212) });
        if(IsMediaSetting(spec.Path)) {row.ColumnDefinitions[0].Width=new GridLength(1,GridUnitType.Star);row.ColumnDefinitions[1].Width=new GridLength(1.35,GridUnitType.Star);}
        var copy=new StackPanel { Margin=new Thickness(0,0,18,0), VerticalAlignment=VerticalAlignment.Center };
        copy.Children.Add(new TextBlock { Text=spec.Title, FontSize=12, FontWeight=FontWeights.Medium, TextWrapping=TextWrapping.Wrap });
        copy.Children.Add(new TextBlock { Text=spec.Help, Foreground=Ink("Muted"), FontSize=10, TextWrapping=TextWrapping.Wrap, LineHeight=17, Margin=new Thickness(0,5,0,0) });
        var status=new TextBlock {FontSize=10,Foreground=Ink("Accent"),TextWrapping=TextWrapping.Wrap,LineHeight=17,Margin=new Thickness(0,5,0,0),Visibility=Visibility.Collapsed};copy.Children.Add(status);
        if(spec.Path=="social.mediaEnabled") {var configure=new Button{Content="配置媒体服务",Style=(Style)window.FindResource("Quiet"),FontSize=10,MinHeight=28,Padding=new Thickness(8,5,8,5),HorizontalAlignment=HorizontalAlignment.Left,Margin=new Thickness(0,7,0,0)};configure.Click+=(s,e)=>NavigateRuntime(2);System.Windows.Automation.AutomationProperties.SetAutomationId(configure,"ConfigureMediaService");copy.Children.Add(configure);}
        row.Children.Add(copy);Control input;FrameworkElement holder;
        var error=new TextBlock { Foreground=Ink("Danger"), FontSize=10, Margin=new Thickness(0,4,0,0), TextWrapping=TextWrapping.Wrap, Visibility=Visibility.Collapsed };
        bool list=value is IEnumerable && !(value is string); bool numeric=!(value is bool)&&!(value is string)&&!list;
        if(value is bool) { var check=new CheckBox { IsChecked=(bool)value, HorizontalAlignment=HorizontalAlignment.Right };check.Checked+=(s,e)=>SettingChanged(spec.Path);check.Unchecked+=(s,e)=>SettingChanged(spec.Path);input=check;holder=check; }
        else if(choices.ContainsKey(spec.Path)) { var select=new ComboBox { ItemsSource=choices[spec.Path].Select(item=>new Choice { Value=item.Split('|')[0],Label=item.Split('|')[1] }).ToList(),DisplayMemberPath="Label",SelectedValuePath="Value",SelectedValue=value };select.SelectionChanged+=(s,e)=>SettingChanged(spec.Path);input=select;holder=select; }
        else {
            var text=new TextBox { Text=list?string.Join(", ",((IEnumerable)value).Cast<object>()):Convert.ToString(value,CultureInfo.InvariantCulture), Tag=list?"多个值用逗号分隔":spec.Path.StartsWith("social.")&&spec.Path.Contains("Model")?"可选模型名称":"", VerticalAlignment=VerticalAlignment.Center };
            text.TextChanged+=(s,e)=>SettingChanged(spec.Path);input=text;holder=text;
            if(spec.Path=="approval.adminQq") {
                text.Tag="输入管理员 QQ 号";text.MaxLength=16;
                text.LostKeyboardFocus+=(s,e)=>ValidateSetting(spec,text,error);
            }
            else if(numeric) {
                var box=new Grid();box.ColumnDefinitions.Add(new ColumnDefinition {Width=new GridLength(28)});box.ColumnDefinitions.Add(new ColumnDefinition());box.ColumnDefinitions.Add(new ColumnDefinition {Width=GridLength.Auto});box.ColumnDefinitions.Add(new ColumnDefinition {Width=new GridLength(28)});
                var minus=new Button { Content="−",Padding=new Thickness(0),MinHeight=34,Background=Brushes.Transparent,BorderThickness=new Thickness(0),ToolTip="减少" };
                var plus=new Button { Content="+",Padding=new Thickness(0),MinHeight=34,Background=Brushes.Transparent,BorderThickness=new Thickness(0),ToolTip="增加" };
                Action<long> step=direction=> { long current; if(!long.TryParse(text.Text,out current))current=spec.Min; text.Text=direction>0?Math.Min(spec.Max,current>spec.Max-spec.Step?spec.Max:current+spec.Step).ToString():Math.Max(spec.Min,current<spec.Min+spec.Step?spec.Min:current-spec.Step).ToString();ValidateSetting(spec,text,error); };
                minus.Click+=(s,e)=>step(-1);plus.Click+=(s,e)=>step(1);
                System.Windows.Automation.AutomationProperties.SetName(minus,"减少"+spec.Title);System.Windows.Automation.AutomationProperties.SetName(plus,"增加"+spec.Title);
                text.BorderThickness=new Thickness(0);text.Background=Brushes.Transparent;text.Padding=new Thickness(4,8,2,8);text.MinHeight=34;text.HorizontalContentAlignment=HorizontalAlignment.Center;
                Grid.SetColumn(text,1);Grid.SetColumn(plus,3);box.Children.Add(minus);box.Children.Add(text);box.Children.Add(plus);
                if(spec.Unit.Length>0) {var unit=new TextBlock {Text=spec.Unit,FontSize=10,Foreground=Ink("Muted"),VerticalAlignment=VerticalAlignment.Center,Margin=new Thickness(0,0,5,0)};Grid.SetColumn(unit,2);box.Children.Add(unit);}
                holder=new Border {Background=Color("#FAFBFE"),BorderBrush=Color("#DEE5F0"),BorderThickness=new Thickness(1),CornerRadius=new CornerRadius(8),Child=box};
                text.LostKeyboardFocus+=(s,e)=>ValidateSetting(spec,text,error);
            }
            if(list) { row.ColumnDefinitions[1].Width=new GridLength(0);Grid.SetColumnSpan(copy,2);outer.Children.Add(row);text.TextWrapping=TextWrapping.Wrap;text.AcceptsReturn=true;text.MinHeight=52;text.VerticalContentAlignment=VerticalAlignment.Top;text.Margin=new Thickness(0,8,0,3);outer.Children.Add(text); }
        }
        System.Windows.Automation.AutomationProperties.SetName(input,spec.Title);System.Windows.Automation.AutomationProperties.SetAutomationId(input,"Setting-"+spec.Path);fields[spec.Path]=input;
        if(spec.Path=="approval.allowExec")input.IsEnabled=false;
        if(!list) {
            if(compact&&numeric){row.ColumnDefinitions[1].Width=new GridLength(0);Grid.SetColumnSpan(copy,2);outer.Children.Add(row);holder.Margin=new Thickness(0,9,0,2);outer.Children.Add(holder);}
            else {Grid.SetColumn(holder,1);row.Children.Add(holder);outer.Children.Add(row);}
        }outer.Children.Add(error);
        outer.Children.Add(new Border { Background=Color("#F0F3F9"),Height=1,Margin=new Thickness(0,11,0,0) });
        return new FieldView {Spec=spec,Row=outer,Editor=holder,Error=error,Status=status};
    }
    static string[] ListValues(string text) {return text.Split(new[]{',','，',';','；','\r','\n'},StringSplitOptions.RemoveEmptyEntries).Select(item=>item.Trim()).Where(item=>item.Length>0).ToArray();}
    static object CurrentSettingValue(string path) {
        var input=fields[path];if(input is CheckBox)return ((CheckBox)input).IsChecked==true;
        if(input is ComboBox)return ((ComboBox)input).SelectedValue;
        string text=((TextBox)input).Text;object original=FlattenSettings(settings)[path];
        if(original is IEnumerable&&!(original is string))return ListValues(text);
        long number;if(!(original is string)&&long.TryParse(text,out number))return number;
        return text;
    }
    static Dictionary<string,object> CollectDraft(IEnumerable<string> paths) {
        var draft=json.Deserialize<Dictionary<string,object>>(json.Serialize(settings));
        foreach(string path in paths) {var parts=path.Split('.');var parent=draft;for(int i=0;i<parts.Length-1;i++)parent=(Dictionary<string,object>)parent[parts[i]];parent[parts[parts.Length-1]]=CurrentSettingValue(path);}
        return draft;
    }
    static void ReconcileDirtySettings() {
        if(settings==null)return;
        dirtySettingPaths.Clear();foreach(var path in savedSettingValues.Keys)if(fields.ContainsKey(path)&&json.Serialize(CurrentSettingValue(path))!=savedSettingValues[path])dirtySettingPaths.Add(path);
        dirtySections.Remove("settings");dirtySections.Remove("models");
        if(dirtySettingPaths.Any(path=>!IsMediaSetting(path)))dirtySections.Add("settings");
        if(dirtySettingPaths.Any(IsMediaSetting))dirtySections.Add("models");
        dirty=dirtySections.Count>0;Find<TextBlock>("SaveState").Text=dirty?"有尚未保存的修改":"所有修改已保存";
        int pending=dirtySettingPaths.Count(path=>!IsMediaSetting(path));
        Find<TextBlock>("SettingsSaveHint").Text=pending>0?"本页有 "+pending+" 项尚未保存":"机器人设置已保存";
        UpdateConnectionEditing();RefreshDependencies();RefreshMediaEditors();
    }
    static void ApplySavedSettings(Dictionary<string,object> next,IEnumerable<string> savedPaths) {
        var persisted=new HashSet<string>(savedPaths);var pending=new HashSet<string>(dirtySettingPaths.Where(path=>!persisted.Contains(path)));
        var previous=FlattenSettings(settings);next=json.Deserialize<Dictionary<string,object>>(json.Serialize(next));
        foreach(string path in pending) {var parts=path.Split('.');var parent=next;for(int i=0;i<parts.Length-1;i++)parent=(Dictionary<string,object>)parent[parts[i]];parent[parts[parts.Length-1]]=previous[path];}
        bool wasLoading=loading;loading=true;settings=next;
        foreach(var pair in FlattenSettings(next)) {
            savedSettingValues[pair.Key]=json.Serialize(pair.Value);if(pending.Contains(pair.Key)||!fields.ContainsKey(pair.Key))continue;
            var input=fields[pair.Key];if(input is CheckBox)((CheckBox)input).IsChecked=(bool)pair.Value;
            else if(input is ComboBox)((ComboBox)input).SelectedValue=pair.Value;
            else ((TextBox)input).Text=pair.Value is IEnumerable&&!(pair.Value is string)?string.Join(", ",((IEnumerable)pair.Value).Cast<object>()):Convert.ToString(pair.Value,CultureInfo.InvariantCulture);
        }
        loading=wasLoading;ReconcileDirtySettings();
    }
    static void SettingChanged(string path) { if(!loading&&fields.ContainsKey(path)) {ReconcileDirtySettings();if(IsMediaSetting(path))Find<TextBlock>("RuntimeHint").Text="媒体模型参数尚未保存，请使用本页保存按钮；机器人设置中的草稿会继续保留。";} }
    static void AddSettingsLink(StackPanel panel,string category,string title,string search,string help,string action,Action navigate) {
        var body=new StackPanel();body.Children.Add(new TextBlock{Text=title,FontSize=14,FontWeight=FontWeights.SemiBold});
        var summary=new TextBlock{Text=help,FontSize=11,Foreground=Ink("Muted"),TextWrapping=TextWrapping.Wrap,LineHeight=18,Margin=new Thickness(0,9,0,12)};body.Children.Add(summary);
        var button=new Button{Content=action,Style=(Style)window.FindResource("Quiet"),HorizontalAlignment=HorizontalAlignment.Left};button.Click+=(s,e)=>navigate();System.Windows.Automation.AutomationProperties.SetAutomationId(button,"SettingsLink-"+title);body.Children.Add(button);
        var link=new SettingsLink{Category=category,Search=category+title+search,Summary=summary,Surface=new Border{Style=(Style)window.FindResource("Surface"),Margin=new Thickness(0,0,0,14),Child=body}};
        settingsLinks.Add(link);panel.Children.Add(link.Surface);
    }
    static void NavigateSetting(string path) {SelectSetting(path,false);}
    static bool SettingOn(string path) {return fields.ContainsKey(path)&&fields[path] is CheckBox&&((CheckBox)fields[path]).IsChecked==true;}
    static long SettingNumber(string path) {long number;return fields.ContainsKey(path)&&fields[path] is TextBox&&long.TryParse(((TextBox)fields[path]).Text,out number)?number:-1;}
    static void SettingStatus(string path,string text) {if(fieldViews.ContainsKey(path)){fieldViews[path].Status.Text=text;fieldViews[path].Status.Visibility=text.Length>0?Visibility.Visible:Visibility.Collapsed;}}
    static void RefreshDependencies() {
        Action<string,bool> enabled=(key,on)=>{if(fields.ContainsKey(key)){fields[key].IsEnabled=on;if(fieldViews.ContainsKey(key))fieldViews[key].Editor.IsEnabled=on;}};
        if(fields.ContainsKey("social.allowAll")) {bool allow=((CheckBox)fields["social.allowAll"]).IsChecked==true;enabled("social.allowedGroups",!allow);enabled("social.allowedUsers",!allow);}
        if(fields.ContainsKey("social.responseMode")) {var choice=((ComboBox)fields["social.responseMode"]).SelectedItem as Choice;string mode=choice==null?"":choice.Value;enabled("chat.group.requireMention",mode=="legacy");enabled("social.responseProbability",mode=="probability");enabled("social.keywords",mode=="keywords"||mode=="probability");}
        if(fields.ContainsKey("social.proactiveEnabled")) {bool on=((CheckBox)fields["social.proactiveEnabled"]).IsChecked==true;foreach(string key in new[]{"social.proactiveIntervalMinutes","social.quietStartHour","social.quietEndHour"})enabled(key,on);}
        if(fields.ContainsKey("social.autoQzoneEnabled"))enabled("social.qzoneIntervalHours",((CheckBox)fields["social.autoQzoneEnabled"]).IsChecked==true);
        enabled("social.qzoneCommentIntervalMinutes",SettingOn("social.autoQzoneCommentEnabled"));
        enabled("social.autoQzoneCommentUsers",SettingOn("social.autoQzoneCommentEnabled"));
        enabled("context.rolloverPercent",SettingOn("context.rollover"));
        enabled("features.qzone.commentsEnabled",SettingOn("features.qzone.browseEnabled"));
        SettingStatus("features.qzone.browseEnabled",SettingOn("features.qzone.browseEnabled")?"使用 NapCat 当前 QQ 账号，只读取该账号有权访问的自己或好友说说。":"空间浏览已关闭；发布自己的说说使用独立开关。");
        SettingStatus("features.qzone.commentsEnabled",!SettingOn("features.qzone.browseEnabled")?"请先开启空间浏览。":!SettingOn("features.qzone.commentsEnabled")?"评论与回复已关闭。":SettingNumber("features.qzone.commentDailyLimit")==0?"每日评论上限为 0，不会发送评论。":SettingOn("features.qzone.commentRequireConfirm")&&SettingNumber("approval.adminQq")==0?"评论前需确认，请先设置管理员 QQ。":"评论已开启，受独立额度、联系范围和确认规则约束。");
        SettingStatus("learning.memory",SettingOn("learning.memory")?"需要明确会话、分析模型和学习额度；在 QQ 活动查看学习记录。":"自动整理已关闭；手动记忆和相关性召回仍可使用。");
        int hour=TimeZoneInfo.ConvertTimeBySystemTimeZoneId(DateTime.UtcNow,"China Standard Time").Hour;long start=SettingNumber("social.quietStartHour"),end=SettingNumber("social.quietEndHour");bool quiet=start>=0&&end>=0&&start!=end&&(start<end?hour>=start&&hour<end:hour>=start||hour<end);
        string background=!SettingOn("social.proactiveEnabled")?"等待开启后台自主活动":!SettingOn("social.autonomousEnabled")?"等待开启持续兴趣与想法":SettingNumber("social.autonomousDecisionsPerDay")==0?"每日后台判断上限为 0，后台不会唤醒模型":SettingNumber("social.actionsPerDay")==0?"QQ 动作总额为 0，后台动作暂停":quiet?"当前为上海时间安静时段，后台暂停":"基础条件已满足，等待候选话题、联系间隔与可用额度";
        SettingStatus("social.proactiveEnabled",background);
        SettingStatus("social.autoCollectStickers",!SettingOn("social.autoCollectStickers")?"后台收藏已关闭":!SettingOn("social.stickersEnabled")?"等待开启 QQ 收藏表情":SettingNumber("social.autoCollectPerDay")==0?"每日后台新增收藏为 0":background);
        SettingStatus("social.autoQzoneEnabled",!SettingOn("social.autoQzoneEnabled")?"自主空间创作已关闭":!SettingOn("features.qzone.enabled")?"等待开启 QQ 空间发布":SettingNumber("social.autoQzonePerDay")==0||SettingNumber("features.qzone.dailyLimit")==0?"自主空间或空间总额度为 0":SettingOn("features.qzone.requireConfirm")&&SettingNumber("approval.adminQq")==0?"发布前需确认，请先设置管理员 QQ":background);
        SettingStatus("social.autoQzoneCommentEnabled",!SettingOn("social.autoQzoneCommentEnabled")?"自主空间互动已关闭，仍可按对话要求浏览和评论。":!SettingOn("features.qzone.browseEnabled")||!SettingOn("features.qzone.commentsEnabled")?"请先在功能开关开启空间浏览和评论。":SettingNumber("features.qzone.commentDailyLimit")==0?"空间评论额度为 0。":SettingOn("features.qzone.commentRequireConfirm")&&SettingNumber("approval.adminQq")==0?"评论需确认，请先设置管理员 QQ。":background);
        SettingStatus("social.remindersEnabled",SettingOn("social.remindersEnabled")?"使用独立提醒额度；群提醒还需要群聊主动发言。受阻时等待恢复，结果未知时不自动重发。":"提醒暂停执行，已有任务保留");
        SettingStatus("social.autonomy","空间发布按实际正文合并确认；命令执行和文件修改使用独立的工作区审批。");
        SettingStatus("social.autoCollectPerDay",SettingOn("social.autoCollectStickers")?"后台收藏的独立上限，同时受 QQ 动作总额约束。":"后台收藏已关闭；可先设置额度，开关在主动与提醒管理。");
        SettingStatus("social.autoQzonePerDay",SettingOn("social.autoQzoneEnabled")?"后台发布的独立上限，同时受空间发布总额约束。":"自主空间创作已关闭；可先设置额度，开关在主动与提醒管理。");
        if(Find<TextBlock>("SettingsContext")!=null){Find<TextBlock>("SettingsContext").Text="全局默认 · 会话专属的参与设置优先";Find<TextBlock>("SettingsContext").ToolTip="配置文件："+(settingsPath.Length>0?settingsPath:"当前动态配置文件");}
    }
    static void FilterSettings() {
        if(Find<TextBox>("SettingsSearch")==null||settingsCards.Count==0)return;
        string query=Find<TextBox>("SettingsSearch").Text.Trim();int count=0,links=0;
        foreach(var card in settingsCards) {bool show=false;foreach(var view in card.Rows){bool match=query.Length==0?card.Category==selectedCategory:(view.Spec.Title+view.Spec.Help+view.Spec.Path+card.Category+view.Spec.Card+(view.Spec.Path=="social.mediaEnabled"?"媒体 视觉 转写 合成 声音 抽帧 FFmpeg "+string.Join(" ",mediaKeys):"")).IndexOf(query,StringComparison.OrdinalIgnoreCase)>=0;view.Row.Visibility=match?Visibility.Visible:Visibility.Collapsed;if(match){show=true;count++;}}card.Surface.Visibility=show?Visibility.Visible:Visibility.Collapsed;}
        foreach(var link in settingsLinks) {bool match=query.Length==0?link.Category==selectedCategory:link.Search.IndexOf(query,StringComparison.OrdinalIgnoreCase)>=0;link.Surface.Visibility=match?Visibility.Visible:Visibility.Collapsed;if(match)links++;}
        Find<Border>("SettingsQuotaPanel").Visibility=settingsCards.Any(card=>card.Category=="额度与节奏"&&card.Surface.Visibility==Visibility.Visible)?Visibility.Visible:Visibility.Collapsed;
        Find<TextBlock>("SettingsTitle").Text=query.Length==0?selectedCategory:"搜索结果";
        Find<TextBlock>("SettingsSubtitle").Text=query.Length==0?categoryDescriptions[Array.IndexOf(categoryNames,selectedCategory)]:"找到 "+count+" 项设置和 "+links+" 个相关入口，清空搜索可返回分类。";
        Find<StackPanel>("SettingsEmpty").Visibility=count+links==0?Visibility.Visible:Visibility.Collapsed;
    }
    static bool ValidateSetting(FieldSpec spec,TextBox text,TextBlock error) {
        long value;bool valid=long.TryParse(text.Text,out value)&&value>=spec.Min&&value<=spec.Max;
        if(spec.Path=="approval.adminQq")valid=valid&&text.Text.Length>0&&text.Text.All(c=>c>='0'&&c<='9');
        error.Text=valid?"":spec.Path=="approval.adminQq"?"请输入有效的纯数字 QQ 号，0 表示不设置管理员。":"请输入 "+spec.Min+"–"+spec.Max+" 之间的整数。";error.Visibility=valid?Visibility.Collapsed:Visibility.Visible;
        return valid;
    }
    static bool ValidateSettingsForm() {
        foreach(var view in fieldViews.Values) {if(!categoryNames.Contains(view.Spec.Category))continue;var input=fields[view.Spec.Path] as TextBox;if(input==null)continue;object value=FlattenSettings(settings)[view.Spec.Path];if(value is string||value is IEnumerable)continue;if(!ValidateSetting(view.Spec,input,view.Error)){SelectSetting(view.Spec.Path);return false;}}
        long min,max;if(long.TryParse(((TextBox)fields["chat.delay.minMs"]).Text,out min)&&long.TryParse(((TextBox)fields["chat.delay.maxMs"]).Text,out max)&&min>max) {
            fieldViews["chat.delay.maxMs"].Error.Text="最长回复延迟不能小于最短回复延迟。";fieldViews["chat.delay.maxMs"].Error.Visibility=Visibility.Visible;SelectSetting("chat.delay.maxMs");return false;
        }
        if(SettingNumber("context.warningPercent")>=SettingNumber("context.rolloverPercent")){
            fieldViews["context.rolloverPercent"].Error.Text="会话更换比例应大于上下文提醒比例。";fieldViews["context.rolloverPercent"].Error.Visibility=Visibility.Visible;SelectSetting("context.rolloverPercent");return false;
        }
        var savedSocial=(Dictionary<string,object>)settings["social"];
        if(SettingOn("social.mediaEnabled")&&new[]{"visionModel","transcriptionModel","speechModel"}.Any(key=>Convert.ToString(savedSocial[key]).Trim().Length>0)&&(!savedRuntimeValues.ContainsKey("BOT_MEDIA_BASE_URL")||savedRuntimeValues["BOT_MEDIA_BASE_URL"].Trim().Length==0)) {
            var view=fieldViews["social.mediaEnabled"];view.Error.Text="已保存的独立模型需要媒体服务地址，请先前往媒体服务配置并保存。";view.Error.Visibility=Visibility.Visible;SelectSetting("social.mediaEnabled");return false;
        }
        return true;
    }
    static void SaveRobotSettings() {try {var paths=dirtySettingPaths.Where(path=>!IsMediaSetting(path)).ToArray();if(paths.Length==0){Feedback("机器人设置没有未保存的修改；媒体参数请在媒体服务中保存。");return;}if(ValidateSettingsForm())Send("settings",new{draft=CollectDraft(paths),baseline=settings,paths=paths,settingsPath=settingsPath});}catch(Exception error){Feedback(error.Message);}}
    static void SelectSetting(string path,bool invalid=true) {
        if(IsMediaSetting(path))NavigateRuntime(2);else {SelectedPage=MainPage.Settings;Find<TextBox>("SettingsSearch").Clear();Find<ListBox>("SettingsNav").SelectedItem=((IEnumerable<SettingsCategory>)Find<ListBox>("SettingsNav").ItemsSource).First(c=>c.Name==fieldViews[path].Spec.Category);}
        fieldViews[path].Row.BringIntoView();fields[path].Focus();if(invalid)Feedback("设置需要调整，请检查行内提示。");
    }
    static void VerifySettingsInteraction() {
        if(Find<ListBox>("SettingsNav").Items.Count!=7)throw new Exception("设置分类不完整");
        if(!IsSqliteNotice("(node:123) ExperimentalWarning: SQLite is an experimental feature and might change at any time")||IsSqliteNotice("Error: SQLite database is corrupt"))throw new Exception("SQLite 提示与实际错误未正确区分");
        if(logs.Any(line=>line.Contains("控制进程异常")))throw new Exception("启动时控制进程报告异常");
        string before=json.Serialize(Collect(settings,""));
        var requestPaths=new[]{"perDay","perUserPerDay","perChatPerDay","backgroundPerDay","perMinute","perTurn","concurrent","maxOutputTokens","maxRequestKiB","maxResponseChars","mediaPerDay","nativeWebPerDay"};
        foreach(var requestPath in requestPaths)if(!fieldViews.ContainsKey("requests."+requestPath)||fieldViews["requests."+requestPath].Spec.Category!="额度与节奏")throw new Exception("服务预算设置缺失或分类错误："+requestPath);
        var mode=(ComboBox)fields["social.responseMode"];object originalMode=mode.SelectedValue;
        var number=(TextBox)fields["social.responseProbability"];string originalNumber=number.Text;
        mode.SelectedValue="probability";
        if(!number.IsEnabled)throw new Exception("参与方式没有更新相关控件");
        number.Text="10";
        var editor=(Border)fieldViews["social.responseProbability"].Editor;
        ((Grid)editor.Child).Children.OfType<Button>().Last().RaiseEvent(new RoutedEventArgs(Button.ClickEvent));
        if(number.Text!="15")throw new Exception("数字步进没有生效");
        number.Text="101";
        if(ValidateSettingsForm()||fieldViews["social.responseProbability"].Error.Visibility!=Visibility.Visible)throw new Exception("无效值没有显示行内提示");
        number.Text=originalNumber;ValidateSetting(fieldViews["social.responseProbability"].Spec,number,fieldViews["social.responseProbability"].Error);mode.SelectedValue=originalMode;
        var admin=(TextBox)fields["approval.adminQq"];string originalAdmin=admin.Text;var adminView=fieldViews["approval.adminQq"];
        if(adminView.Editor!=admin)throw new Exception("管理员 QQ 仍使用了数字步进控件");
        admin.Text="3000000001";
        if(!ValidateSetting(adminView.Spec,admin,adminView.Error)||Convert.ToInt64(((Dictionary<string,object>)Collect(settings,"")["approval"])["adminQq"])!=3000000001)throw new Exception("管理员 QQ 没有原样保存");
        admin.Text="+3000000001";if(ValidateSetting(adminView.Spec,admin,adminView.Error))throw new Exception("管理员 QQ 接受了非纯数字输入");
        admin.Text=originalAdmin;ValidateSetting(adminView.Spec,admin,adminView.Error);
        Find<TextBox>("SettingsSearch").Text="主动消息";
        if(!settingsCards.Any(c=>c.Surface.Visibility==Visibility.Visible))throw new Exception("设置搜索没有匹配结果");
        Find<TextBox>("SettingsSearch").Clear();
        var autoCollect=(CheckBox)fields["social.autoCollectStickers"];bool oldCollect=autoCollect.IsChecked==true;
        autoCollect.IsChecked=false;if(!fields["social.autoCollectPerDay"].IsEnabled||!fieldViews["social.autoCollectPerDay"].Status.Text.Contains("已关闭"))throw new Exception("后台额度未清楚区分开关与上限");autoCollect.IsChecked=oldCollect;
        var interests=(TextBox)fields["social.personalInterests"];string oldInterests=interests.Text;interests.Text="猫猫, 轻松日常";
        if(((IEnumerable)((Dictionary<string,object>)Collect(settings,"")["social"])["personalInterests"]).Cast<object>().Count()!=2)throw new Exception("全局创作兴趣未按列表保存");interests.Text=oldInterests;
        var name=(TextBox)fields["identity.name"];string originalName=name.Text;name.Text="测试中的名称";Find<ListBox>("SettingsNav").SelectedIndex=6;Find<ListBox>("SettingsNav").SelectedIndex=5;if(name.Text!="测试中的名称")throw new Exception("切换分类丢失了未保存输入");name.Text=originalName;
        if(json.Serialize(Collect(settings,""))!=before)throw new Exception("切换分类或搜索丢失了设置值");
        for(int i=0;i<7;i++){Find<ListBox>("SettingsNav").SelectedIndex=i;Capture(System.IO.Path.Combine(root,"settings-"+i+".png"),MainPage.Settings);}
        Find<ListBox>("SettingsNav").SelectedIndex=0;
        if(Find<Border>("SettingsQuotaPanel").Visibility!=Visibility.Collapsed)throw new Exception("额度统计仍出现在无关设置分类");
        NavigateSetting("social.actionsPerDay");if(Find<Border>("SettingsQuotaPanel").Visibility!=Visibility.Visible)throw new Exception("额度分类没有显示当前用量");Find<ListBox>("SettingsNav").SelectedIndex=0;
        VerifyAuditInteraction();
        VerifySettingsConsistencyInteraction();
    }
    static void VerifySettingsConsistencyInteraction() {
        var original=json.Deserialize<Dictionary<string,object>>(json.Serialize(settings));var paths=savedSettingValues.Keys.ToArray();
        string originalDraft=json.Serialize(Collect(settings,""));var profiles=new Dictionary<string,Dictionary<string,object>>(socialProfiles);
        string originalService=savedRuntimeValues["BOT_MEDIA_BASE_URL"];
        try {
            ((TextBox)fields["social.allowedUsers"]).Text="987654321";
            var remote=json.Deserialize<Dictionary<string,object>>(json.Serialize(settings["social"]));remote["blockedUsers"]=new[]{"123456789"};
            RenderActivity(new Dictionary<string,object>{{"rows",new object[0]},{"profiles",new object[0]},{"socialSettings",remote},{"total",0},{"note","隔离检查"}});
            if(((TextBox)fields["social.allowedUsers"]).Text!="987654321"||!dirtySettingPaths.Contains("social.allowedUsers"))throw new Exception("刷新活动覆盖了名单草稿");
            if(!((TextBox)fields["social.blockedUsers"]).Text.Contains("123456789"))throw new Exception("远端名单变化没有合并");
            dirtySections.Add("memory");RenderSettingsStatus(new Dictionary<string,object>{{"socialSettings",remote}});
            if(!dirtySections.Contains("memory"))throw new Exception("刷新设置额度影响了未保存的记忆");dirtySections.Remove("memory");
            ((TextBox)fields["identity.name"]).Text="未保存的人设名称";
            var changed=json.Deserialize<Dictionary<string,object>>(json.Serialize(settings));((Dictionary<string,object>)changed["identity"])["name"]="其他操作的新名称";
            ApplySavedSettings(changed,mediaKeys.Select(key=>"social."+key));
            if(((TextBox)fields["identity.name"]).Text!="未保存的人设名称"||!dirtySettingPaths.Contains("identity.name"))throw new Exception("保存媒体配置丢失其他设置草稿");
            if(Convert.ToString(((Dictionary<string,object>)settings["identity"])["name"])!=Convert.ToString(((Dictionary<string,object>)original["identity"])["name"]))throw new Exception("其他入口保存提前覆盖了草稿的冲突基准");
            savedRuntimeValues["BOT_MEDIA_BASE_URL"]="";((CheckBox)fields["social.mediaEnabled"]).IsChecked=true;((TextBox)fields["social.visionModel"]).Text="missing-service";
            if(!ValidateSettingsForm())throw new Exception("媒体服务草稿阻止保存无关的机器人设置");
            if(ValidateConnectionForm())throw new Exception("媒体服务入口绕过了服务地址校验");
            ((TextBox)fields["social.videoFrames"]).Text="invalid";
            var behaviorPaths=dirtySettingPaths.Where(path=>!IsMediaSetting(path)).ToArray();var draft=CollectDraft(behaviorPaths);
            if(Convert.ToInt32(((Dictionary<string,object>)draft["social"])["videoFrames"])!=Convert.ToInt32(((Dictionary<string,object>)settings["social"])["videoFrames"]))throw new Exception("机器人设置包含了媒体参数草稿");
            ApplySavedSettings(draft,savedSettingValues.Keys.Where(path=>!IsMediaSetting(path)).ToArray());
            if(((TextBox)fields["social.videoFrames"]).Text!="invalid"||!dirtySettingPaths.Contains("social.videoFrames"))throw new Exception("保存机器人设置清除了媒体草稿");
            if(settingsCards.Any(card=>card.Rows.Any(view=>IsMediaSetting(view.Spec.Path))))throw new Exception("媒体模型仍出现在机器人设置中");
            foreach(string key in mediaKeys)if(!object.ReferenceEquals(mediaInputs[key],fields["social."+key])||!Find<StackPanel>("RuntimeFields").IsAncestorOf(fieldViews["social."+key].Row))throw new Exception("媒体模型不是单一编辑入口");
            if(fields.Keys.Any(key=>key.StartsWith("web.")||key.StartsWith("features.browsing.")))throw new Exception("已移除的搜索适配设置仍出现在表单中");
            ((CheckBox)fields["features.qzone.browseEnabled"]).IsChecked=false;
            if(fields["features.qzone.commentsEnabled"].IsEnabled)throw new Exception("关闭空间浏览后评论开关仍可编辑");
            ((CheckBox)fields["features.qzone.browseEnabled"]).IsChecked=true;
            if(!fields["features.qzone.commentsEnabled"].IsEnabled)throw new Exception("开启空间浏览后无法设置评论");
        } finally {
            savedRuntimeValues["BOT_MEDIA_BASE_URL"]=originalService;ApplySavedSettings(original,paths);socialProfiles=profiles;
            foreach(var view in fieldViews.Values)view.Error.Visibility=Visibility.Collapsed;
        }
        if(json.Serialize(Collect(settings,""))!=originalDraft)throw new Exception("一致性检查改变了原设置");
    }
    static void VerifyAuditInteraction() {
        var originalLogs=logs.ToArray();bool originalPaused=paused;MainPage originalPage=SelectedPage;
        string originalSearch=Find<TextBox>("LogSearch").Text;int originalFilter=Find<ComboBox>("LogFilter").SelectedIndex;
        try {
            SelectedPage=MainPage.Logs;Find<TextBox>("LogSearch").Clear();Find<ComboBox>("LogFilter").SelectedIndex=0;
            logs.Clear();for(int i=0;i<300;i++)logs.Enqueue("[bridge] 审查日志 "+i);paused=false;RefreshLogs();window.UpdateLayout();
            var editor=Find<TextBox>("Logs");editor.ScrollToVerticalOffset(100);window.UpdateLayout();double offset=editor.VerticalOffset;
            if(offset<=0)throw new Exception("日志滚动测试没有产生可滚动内容");
            paused=true;logs.Enqueue("[bridge] 暂停滚动后的新日志");RefreshLogs();window.UpdateLayout();
            if(Math.Abs(editor.VerticalOffset-offset)>1)throw new Exception("暂停滚动时日志仍跳回顶部或底部");
        } finally {
            logs.Clear();foreach(string line in originalLogs)logs.Enqueue(line);paused=originalPaused;
            Find<TextBox>("LogSearch").Text=originalSearch;Find<ComboBox>("LogFilter").SelectedIndex=originalFilter;RefreshLogs();SelectedPage=originalPage;
        }
        string hint=Find<TextBlock>("RuntimeHint").Text;bool pending=connectionRestartPending;
        connectionRestartPending=true;Event("{\"type\":\"control\",\"action\":\"restartBridge\",\"ok\":false}");
        if(connectionRestartPending||!Find<TextBlock>("RuntimeHint").Text.Contains("未完成"))throw new Exception("重启失败被误报为完成");
        connectionRestartPending=pending;Find<TextBlock>("RuntimeHint").Text=hint;
    }
}
