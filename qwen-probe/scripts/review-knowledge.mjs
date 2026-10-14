import {openSync,closeSync,fstatSync,readFileSync,writeFileSync,mkdirSync} from 'node:fs';
import {join,resolve} from 'node:path';
import {fileURLToPath} from 'node:url';
import {comparisonDigest,prepareHumanReview,summarizeHumanReview} from '../knowledge-review.mjs';

const LIMIT=4*1024*1024;
const DEFAULT_DIRECTORY=fileURLToPath(new URL('../../docs/validation/knowledge-rag/',import.meta.url));
const DEFAULT_CASES=fileURLToPath(new URL('../../docs/validation/coach-quality-cases.jsonl',import.meta.url));
const ERROR_CODES=new Set(['INVALID_REVIEW_MODE','REVIEW_FILE_TOO_LARGE','REVIEW_FILE_INVALID','REVIEW_RATINGS_EXIST','REVIEW_REQUEST_DIGEST_MISMATCH',
  'INVALID_COMPARISON_REQUESTS','COMPARISON_ARMS_DIFFER','INVALID_REVIEW_INPUT','CASES_DO_NOT_MATCH_REQUESTS','RESULTS_DO_NOT_MATCH_REQUESTS',
  'INVALID_COMPARISON_RESULTS','INVALID_REVIEW_PACKET','INVALID_HUMAN_RATINGS']);
const fail=code=>{throw new Error(code);};
function readText(path,{optional=false}={}){
  let descriptor;
  try{
    try{descriptor=openSync(path,'r');}catch(error){if(optional&&error.code==='ENOENT')return undefined;throw error;}
    const info=fstatSync(descriptor);if(!info.isFile())fail('REVIEW_FILE_INVALID');if(info.size>LIMIT)fail('REVIEW_FILE_TOO_LARGE');
    const bytes=readFileSync(descriptor);if(bytes.length>LIMIT)fail('REVIEW_FILE_TOO_LARGE');return bytes.toString('utf8');
  }catch(error){if(ERROR_CODES.has(error.message))throw error;fail('REVIEW_FILE_INVALID');}
  finally{if(descriptor!==undefined)closeSync(descriptor);}
}
function readJson(path,options){
  const content=readText(path,options);if(content===undefined)return undefined;
  try{return JSON.parse(content);}catch{fail('REVIEW_FILE_INVALID');}
}
function readCases(path){
  const content=readText(path);
  try{return content.trim()?content.trim().split(/\r?\n/u).map(line=>JSON.parse(line)):[];}catch{fail('REVIEW_FILE_INVALID');}
}
function protectRatings(path){
  const existing=readJson(path,{optional:true});if(existing===undefined)return;
  const blank=value=>value===null||value===undefined||typeof value==='string'&&!value.trim();
  if(existing?.schemaVersion!==1||!Array.isArray(existing.ratings)||existing.ratings.some(row=>!row||typeof row!=='object'||Array.isArray(row)
    ||Object.entries(row).some(([key,value])=>!['caseId','sample'].includes(key)&&!blank(value))))fail('REVIEW_RATINGS_EXIST');
}
const number=value=>typeof value==='number'&&Number.isFinite(value)?value.toFixed(3):'未知';
const percentage=value=>typeof value==='number'&&Number.isFinite(value)?`${(value*100).toFixed(1)}%`:'未知';
function reportMarkdown(report){
  const lines=['# 本地生成结果人工评阅','',`状态：${report.status}；语义评阅：${report.semanticQuality}；学习效果：${report.learningOutcome}。`,
    `模型：${report.model}；语料：${report.corpusVersion}。`,'',
    '结果由用户提供，来源与真实调用情况未经独立验证。本命令只读写本地文件，不读取凭据或调用模型。请求摘要只检查文件对应关系。',
    '分组名称在评阅包中隐藏；回答或引用仍可能提示组别，因此不是严格双盲。分数来自人工评阅，不能据此证明真实学习效果。知识卡支持仅指所给编辑卡的用法／例句是否支持建议，不证明机构原文认可该卡片或纠错。',''];
  if(report.status==='not_run')lines.push('尚未导入生成结果：未运行（not_run），没有可评阅的模型回答。','');
  lines.push('| 组别 | 计划 | 完成 | 失败 | 缺失 | 已评阅 | 未评阅 | 正确性 0–2 | 原意保持 0–2 | 语境适合 0–2 | 误纠率 | 知识卡支持 0–2 | 引用覆盖率 |',
    '| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |');
  for(const arm of ['baseline','rag']){
    const value=report.arms[arm];
    lines.push(`| ${arm} | ${value.requested} | ${value.completed} | ${value.failed} | ${value.missing} | ${value.reviewed} | ${value.unreviewed} | ${number(value.correctness)} | ${number(value.meaningPreserved)} | ${number(value.contextFit)} | ${percentage(value.falseCorrectionRate)} | ${number(value.sourceSupport)} | ${percentage(value.citationCoverage)} |`);
  }
  lines.push('','各组分数先按回答平均人工评分，再按回答平均；失败、缺失和未评阅回答不计入评分均值。无引用回答不进入知识卡支持的分母，引用覆盖率按已完成回答计。',
    '',`双方均完成且已评阅的案例：${report.paired.caseCount}。以下差值为 RAG 减 baseline，仅使用这些成对案例。`,
    '',`正确性差值：${number(report.paired.correctnessDelta)}；原意保持差值：${number(report.paired.meaningPreservedDelta)}；语境适合差值：${number(report.paired.contextFitDelta)}；误纠率差值：${number(report.paired.falseCorrectionDelta)}。`,'');
  return lines.join('\n');
}
function writeArtifacts(directory,artifacts){
  const serialized=Object.entries(artifacts).map(([name,value])=>[name,typeof value==='string'?value:JSON.stringify(value,null,2)+'\n']);
  if(serialized.some(([,content])=>Buffer.byteLength(content,'utf8')>LIMIT))fail('REVIEW_FILE_TOO_LARGE');
  mkdirSync(directory,{recursive:true});
  for(const [name,content] of serialized)writeFileSync(join(directory,name),content);
}

// Only local files are accepted. There is no credential lookup or model transport.
export function runReviewWorkflow({directory=DEFAULT_DIRECTORY,casesFile=DEFAULT_CASES,mode}={}){
  try{
    if(!['prepare','score'].includes(mode))fail('INVALID_REVIEW_MODE');
    const prepared=readJson(join(directory,'model-comparison-requests.json'));
    let report;
    if(mode==='prepare'){
      const cases=readCases(casesFile);protectRatings(join(directory,'human-review-ratings.json'));
      const bundle=readJson(join(directory,'model-comparison-results.json'),{optional:true});
      const review=prepareHumanReview(prepared,cases,bundle);
      report=summarizeHumanReview(review,review.ratingsTemplate);
      const artifacts={'generation-review-report.json':report,'generation-review-report.md':reportMarkdown(report)};
      if(bundle!==undefined)Object.assign(artifacts,{'blind-review-packet.json':review.packet,'blind-review-key.json':review.key,'human-review-ratings.json':review.ratingsTemplate});
      writeArtifacts(directory,artifacts);
    }else{
      const packet=readJson(join(directory,'blind-review-packet.json')),key=readJson(join(directory,'blind-review-key.json')),
        ratings=readJson(join(directory,'human-review-ratings.json'));
      if(key?.requestDigest!==comparisonDigest(prepared))fail('REVIEW_REQUEST_DIGEST_MISMATCH');
      const review={schemaVersion:1,reviewId:key.reviewId,requestDigest:key.requestDigest,status:key.status,model:key.model,corpusVersion:key.corpusVersion,packet,key};
      report=summarizeHumanReview(review,ratings);
      writeArtifacts(directory,{'generation-review-report.json':report,'generation-review-report.md':reportMarkdown(report)});
    }
    return report;
  }catch(error){if(ERROR_CODES.has(error.message))throw new Error(error.message);throw new Error('KNOWLEDGE_REVIEW_FAILED');}
}

if(process.argv[1]&&resolve(process.argv[1])===fileURLToPath(import.meta.url)){
  try{
    if(process.argv.length!==3)fail('INVALID_REVIEW_MODE');
    const report=runReviewWorkflow({mode:process.argv[2]});
    console.log(JSON.stringify({status:report.status,semanticQuality:report.semanticQuality,learningOutcome:report.learningOutcome,model:report.model,
      completed:report.arms.baseline.completed+report.arms.rag.completed,reviewed:report.arms.baseline.reviewed+report.arms.rag.reviewed,pairedCases:report.paired.caseCount}));
  }catch(error){console.error(ERROR_CODES.has(error.message)?error.message:'KNOWLEDGE_REVIEW_FAILED');process.exitCode=1;}
}
