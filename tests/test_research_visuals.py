from copy import deepcopy

import pytest

from career_workflow.research_visuals import apply_visual_research, validate_visual_research


def reviewed_image():
    # Optimizer URLs are real image URLs even when the path has no file extension.
    page = "https://example.com/product"
    asset = "https://example.com/_image?href=%2Fassets%2Farchitecture.png&w=1200"
    return {
        "media": [{"kind": "image", "url": asset, "source_url": page, "caption": "Official architecture illustration showing the product's components.", "alt": "Product architecture", "as_of": "2026-09-21"}],
        "sources": [{"url": page, "title": "Product", "publisher": "Example", "published_at": ""}],
        "review": {
            "outcome": "images_selected", "summary": "Selected the official architecture illustration.",
            "pages_checked": [{"url": page, "status": "inspected", "notes": "Followed the image link and inspected the architecture illustration."}],
            "candidates": [{"url": asset, "source_url": page, "visual_inspected": True, "decision": "selected", "reason": "Explains which components the company provides."}],
        },
    }


def test_visual_results_replace_demo_fallback_and_preserve_company_evidence():
    result = reviewed_image()
    original = {"official_name": "Example", "explainer": {"plain_english": "Builds a product", "media": [{"kind": "demo"}]}, "sources": []}
    before = deepcopy(original)
    merged = apply_visual_research(original, result)
    assert original == before
    assert merged["explainer"]["plain_english"] == "Builds a product"
    assert merged["explainer"]["media"][0]["url"] == result["media"][0]["url"]
    assert merged["visual_review"] == result["review"]
    assert merged["sources"] == result["sources"]


@pytest.mark.parametrize("fault", ["no_review", "no_pages", "no_image", "unseen_image", "missing_candidate", "missing_source", "missing_caption", "inaccessible_page"])
def test_visual_validation_rejects_silent_omission_and_unverified_selection(fault):
    result = reviewed_image()
    if fault == "no_review": result.pop("review")
    elif fault == "no_pages": result["review"]["pages_checked"] = []
    elif fault == "no_image": result["media"][0]["kind"] = "demo"
    elif fault == "unseen_image": result["review"]["candidates"][0]["visual_inspected"] = False
    elif fault == "missing_candidate": result["review"]["candidates"] = []
    elif fault == "missing_source": result["sources"] = []
    elif fault == "missing_caption": result["media"][0]["caption"] = ""
    elif fault == "inaccessible_page": result["review"]["pages_checked"][0]["status"] = "unavailable"
    with pytest.raises(ValueError, match="Visual research incomplete"):
        validate_visual_research(result)


def test_no_relevant_images_requires_an_inspected_source_and_candidate_decisions():
    result = reviewed_image()
    result["media"] = []
    result["review"].update(outcome="no_relevant_images", summary="The only image was a decorative background, not a product illustration.")
    candidate = result["review"]["candidates"][0]
    candidate.update(decision="irrelevant", reason="Decorative background without explanatory content.")
    validate_visual_research(result)
    candidate["visual_inspected"] = False
    with pytest.raises(ValueError, match="requires visual inspection"):
        validate_visual_research(result)


def test_access_blockers_are_distinct_from_no_relevant_images():
    result = reviewed_image()
    result["media"] = []
    result["review"].update(outcome="sources_unavailable", summary="The asset could not be opened for visual inspection.")
    result["review"]["candidates"][0].update(decision="unavailable", visual_inspected=False, reason="Image host returned an access error.")
    validate_visual_research(result)
    result["review"]["outcome"] = "no_relevant_images"
    with pytest.raises(ValueError, match="must be reported as unavailable"):
        validate_visual_research(result)
